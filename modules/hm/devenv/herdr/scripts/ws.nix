{
  pkgs,
  herdrPkg,
  username,
}:

pkgs.writeShellApplication {
  name = "ws";

  runtimeInputs = [
    herdrPkg
    pkgs.fzf
    pkgs.jq
    pkgs.coreutils
    pkgs.findutils
  ];

  # Workspace picker: fuzzy-search dirs, then focus or create a herdr workspace.
  text = ''
    search_dirs=(
    # path:depth
      "/home/${username}/Projects:2"
      "/home/${username}/work:3"
      "/home/${username}:2"
    )

    repos=()
    for dir in "''${search_dirs[@]}"; do
      path="''${dir%%:*}"
      depth="''${dir##*:}"
      while IFS= read -r d; do
        repos+=("$(dirname "$d")")
      # find dirs by name, excluding dotfiles not containing .git and current dir
      done < <(find "$path" -maxdepth "$depth" \( -name '.*' -not -name .git -not -name . \) -prune 2>/dev/null)
    done

    target=$(printf '%s\n' "''${repos[@]}" | sort -u | fzf --prompt="workspace: ")
    [[ -n "$target" ]] || exit 0

    # Canonicalize for stable lookup (handles symlinks, ./, trailing slash).
    if command -v realpath >/dev/null 2>&1; then
      target=$(realpath -m "$target" 2>/dev/null || echo "$target")
    elif command -v readlink >/dev/null 2>&1; then
      target=$(readlink -f "$target" 2>/dev/null || echo "$target")
    fi

    # Make sure a server is running before using the CLI.
    # `herdr status server` exits 0 even when stopped, so probe with
    # `herdr workspace list` (rc 1 means no server) and poll on that.
    if [[ -z "''${HERDR_ENV:-}" ]] && ! herdr workspace list >/dev/null 2>&1; then
      nohup herdr server >/dev/null 2>&1 &
      disown 2>/dev/null || true
      for _ in {1..50}; do
        herdr workspace list >/dev/null 2>&1 && break
        sleep 0.1
      done
    fi

    label=$(basename "$target")

    map_file="''${XDG_CONFIG_HOME:-$HOME/.config}/herdr/ws.json"
    mkdir -p "$(dirname "$map_file")"
    if [[ ! -f "$map_file" ]]; then
      echo "{}" > "$map_file"
    fi
    # Ensure valid JSON, reset if corrupted
    if ! jq empty "$map_file" >/dev/null 2>&1; then
      echo "{}" > "$map_file"
    fi

    ws_id=""
    # 1) Stable mapping file (survives cd and restarts)
    if [[ -f "$map_file" ]]; then
      ws_id=$(jq -r --arg cwd "$target" '.[$cwd] // empty' "$map_file" 2>/dev/null || true)
      if [[ -n "$ws_id" ]]; then
        if ! herdr workspace get "$ws_id" >/dev/null 2>&1; then
          ws_id=""
          tmp=$(mktemp)
          if jq --arg cwd "$target" 'del(.[$cwd])' "$map_file" > "$tmp" 2>/dev/null; then
            mv "$tmp" "$map_file"
          else
            rm -f "$tmp"
          fi
        fi
      fi
    fi

    # 2) Fallback: session.json identity_cwd (best-effort for workspaces created
    #    before the mapping file existed; herdr updates identity_cwd on cd, so
    #    this may be stale but still useful as a second chance).
    if [[ -z "$ws_id" ]]; then
      session_file="''${XDG_CONFIG_HOME:-$HOME/.config}/herdr/session.json"
      if [[ -f "$session_file" ]] && jq empty "$session_file" >/dev/null 2>&1; then
        # Direct match
        ws_id=$(jq -r --arg cwd "$target" '.workspaces[] | select(.identity_cwd == $cwd) | .id // empty' "$session_file" 2>/dev/null | head -n1 || true)
        # Canonicalized fallback: compare realpath of stored identity_cwd
        if [[ -z "$ws_id" ]] && command -v realpath >/dev/null 2>&1; then
          while IFS= read -r ws_json; do
            ws_cwd=$(echo "$ws_json" | jq -r '.identity_cwd // empty')
            ws_id_cand=$(echo "$ws_json" | jq -r '.id // empty')
            if [[ -n "$ws_cwd" && -n "$ws_id_cand" ]]; then
              ws_canon=$(realpath -m "$ws_cwd" 2>/dev/null || echo "$ws_cwd")
              if [[ "$ws_canon" == "$target" ]]; then
                if herdr workspace get "$ws_id_cand" >/dev/null 2>&1; then
                  ws_id="$ws_id_cand"
                  break
                fi
              fi
            fi
          done < <(jq -c '.workspaces[]' "$session_file" 2>/dev/null)
        fi
        if [[ -n "$ws_id" ]] && ! herdr workspace get "$ws_id" >/dev/null 2>&1; then
          ws_id=""
        fi
      fi
    fi

    # 3) Fallback: live pane cwd (covers unsaved workspaces and immediate creation)
    if [[ -z "$ws_id" ]]; then
      ws_id=$(herdr pane list 2>/dev/null | jq -r --arg cwd "$target" '.. | objects | select(.cwd == $cwd) | .workspace_id // empty' | head -n1 || true)
      if [[ -z "$ws_id" ]] && command -v realpath >/dev/null 2>&1; then
        while IFS= read -r pane_json; do
          pane_cwd=$(echo "$pane_json" | jq -r '.cwd // empty')
          pane_ws=$(echo "$pane_json" | jq -r '.workspace_id // empty')
          if [[ -n "$pane_cwd" && -n "$pane_ws" ]]; then
            pane_canon=$(realpath -m "$pane_cwd" 2>/dev/null || echo "$pane_cwd")
            if [[ "$pane_canon" == "$target" ]]; then
              ws_id="$pane_ws"
              break
            fi
          fi
        done < <(herdr pane list 2>/dev/null | jq -c '.result.panes[]?' 2>/dev/null)
      fi
    fi

    if [[ -n "$ws_id" ]]; then
      if herdr workspace focus "$ws_id" >/dev/null 2>&1; then
        tmp=$(mktemp)
        if jq --arg cwd "$target" --arg id "$ws_id" '.[$cwd] = $id' "$map_file" > "$tmp" 2>/dev/null; then
          mv "$tmp" "$map_file"
        else
          rm -f "$tmp"
        fi
      fi
    else
      create_out=$(herdr workspace create --cwd "$target" --label "$label" --focus 2>/dev/null || true)
      ws_id=$(echo "$create_out" | jq -r '.result.workspace.workspace_id // empty' 2>/dev/null || true)
      if [[ -z "$ws_id" ]]; then
        ws_id=$(herdr pane list 2>/dev/null | jq -r --arg cwd "$target" '.. | objects | select(.cwd == $cwd) | .workspace_id // empty' | head -n1 || true)
        if [[ -z "$ws_id" ]] && command -v realpath >/dev/null 2>&1; then
          while IFS= read -r pane_json; do
            pane_cwd=$(echo "$pane_json" | jq -r '.cwd // empty')
            pane_ws=$(echo "$pane_json" | jq -r '.workspace_id // empty')
            if [[ -n "$pane_cwd" && -n "$pane_ws" ]]; then
              pane_canon=$(realpath -m "$pane_cwd" 2>/dev/null || echo "$pane_cwd")
              if [[ "$pane_canon" == "$target" ]]; then
                ws_id="$pane_ws"
                break
              fi
            fi
          done < <(herdr pane list 2>/dev/null | jq -c '.result.panes[]?' 2>/dev/null)
        fi
      fi
      if [[ -n "$ws_id" ]]; then
        tmp=$(mktemp)
        if jq --arg cwd "$target" --arg id "$ws_id" '.[$cwd] = $id' "$map_file" > "$tmp" 2>/dev/null; then
          mv "$tmp" "$map_file"
        else
          rm -f "$tmp"
        fi
      fi
    fi

    # From a base terminal, land inside herdr.
    if [[ -z "''${HERDR_ENV:-}" ]]; then
      exec herdr
    fi
  '';
}
