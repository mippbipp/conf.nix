# computer-use-linux: Linux desktop control over MCP (AT-SPI trees,
# compositor window targeting, screenshots, input synthesis).
# Upstream: https://github.com/agent-sh/computer-use-linux
# No flake.nix upstream and not in nixpkgs, so fetch the release binaries.
# Gram-only: the other hosts are WSL guests or headless servers with no
# desktop to control.
{
  pkgs,
  lib,
  ...
}:
let
  version = "0.5.0";
  assets = {
    x86_64-linux = {
      target = "x86_64-unknown-linux-gnu";
      mainHash = "sha256-0h55gzb1xrae98hTKIZjmVD+JIVeLbsgXMPzRSiUAg4=";
      cosmicHash = "sha256-wet2Dul9UNwVfWcRlWzYT5dwHJmIVbI8HvG9d2GaFFg=";
    };
    aarch64-linux = {
      target = "aarch64-unknown-linux-gnu";
      mainHash = "sha256-UScY62T5HNjvyWEHJ/ZfQOyTIYv+dRprtg/jYmaOIqY=";
      cosmicHash = "sha256-IlALWHrGUKw8yMTd2MdcD9ov0B9Or/0cpIKA3btiCvo=";
    };
  };
  cfg =
    assets.${pkgs.stdenv.hostPlatform.system}
      or (throw "computer-use-linux: unsupported system ${pkgs.stdenv.hostPlatform.system}");
  releaseBase = "https://github.com/agent-sh/computer-use-linux/releases/download/v${version}";
  fetchBin =
    name: hash:
    pkgs.fetchurl {
      url = "${releaseBase}/${name}-${cfg.target}";
      inherit hash;
    };
  mainBin = fetchBin "computer-use-linux" cfg.mainHash;
  cosmicBin = fetchBin "computer-use-linux-cosmic" cfg.cosmicHash;
  computer-use-linux = pkgs.stdenv.mkDerivation {
    pname = "computer-use-linux";
    inherit version;
    dontUnpack = true;
    installPhase = ''
      mkdir -p $out/bin
      install -m0755 ${mainBin} $out/bin/computer-use-linux
      install -m0755 ${cosmicBin} $out/bin/computer-use-linux-cosmic
    '';
    meta = {
      description = "Linux desktop control over MCP";
      homepage = "https://github.com/agent-sh/computer-use-linux";
      license = lib.licenses.mit;
      platforms = builtins.attrNames assets;
      mainProgram = "computer-use-linux";
    };
  };
in
{
  # AT-SPI bus for accessibility trees. Without this NixOS sets
  # NO_AT_BRIDGE=1 and doctor reports can_build_accessibility_tree=false.
  services.gnome.at-spi2-core.enable = true;

  environment.systemPackages = [
    computer-use-linux
    # Layout-safe typing on Hyprland Wayland; satisfies doctor keyboard input.
    pkgs.wtype
    # Deterministic fallback; daemon runs per-user below.
    pkgs.ydotool
  ];

  # Per-user ydotoold, mirroring upstream install.sh. Never system-wide:
  # doctor only trusts sockets under $XDG_RUNTIME_DIR or /tmp.
  # No --socket-own: the runtime dir is already 700 user-private and
  # ydotoold defaults the socket to 0600; chowning to %U:%U fails
  # when no group matches the UID (exit 2, start-limit-hit).
  systemd.user.services.ydotoold = {
    description = "ydotool user daemon (fallback input for computer-use-linux)";
    wantedBy = [ "default.target" ];
    serviceConfig = {
      Type = "simple";
      ExecStart = "${lib.getExe' pkgs.ydotool "ydotoold"} --socket-path=%t/.ydotool_socket";
      Restart = "on-failure";
    };
  };
}
