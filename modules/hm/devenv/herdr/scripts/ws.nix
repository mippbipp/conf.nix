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

    # Make sure a server is running before using the CLI.
    # `herdr status server` exits 0 even when stopped, so probe with
    # `herdr workspace list` (rc 1 means no server) and poll on that.
    if [[ -z "''${HERDR_ENV:-}" ]] && ! herdr workspace list >/dev/null 2>&1; then
      nohup herdr server >/dev/null 2>&1 &
      for _ in {1..50}; do
        herdr workspace list >/dev/null 2>&1 && break
        sleep 0.1
      done
    fi

    label=$(basename "$target")
    # `herdr workspace list` omits .cwd; panes carry it.
    ws_id=$(herdr pane list 2>/dev/null | jq -r --arg cwd "$target" '.. | objects | select(.cwd == $cwd) | .workspace_id // empty' | head -n1 || true)

    if [[ -n "$ws_id" ]]; then
      herdr workspace focus "$ws_id" >/dev/null 2>&1 || true
    else
      herdr workspace create --cwd "$target" --label "$label" --focus >/dev/null 2>&1 || true
    fi

    # From a base terminal, land inside herdr.
    if [[ -z "''${HERDR_ENV:-}" ]]; then
      herdr
    fi
  '';
}
