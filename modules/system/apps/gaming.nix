{ username, pkgs, ... }:
{
  # Needed For Some Steam Games
  boot.kernel.sysctl = {
    "vm.max_map_count" = 2147483642;
  };
  programs.steam = {
    enable = true;
    gamescopeSession = {
      enable = true;
      # Offload carve-out, ticket #183 / ADR-0004: the gamescope session is an
      # opt-in gaming session, so the offload triple applies session-wide there.
      env = {
        __NV_PRIME_RENDER_OFFLOAD = "1";
        __GLX_VENDOR_LIBRARY_NAME = "nvidia";
        __VK_LAYER_NV_optimus = "NVIDIA_only";
      };
    };
    remotePlay.openFirewall = true;
    dedicatedServer.openFirewall = true;
    extraCompatPackages = [ pkgs.proton-ge-bin ];
  };
  programs.gamemode.enable = true;

  # https://wiki.nixos.org/wiki/Lutris
  environment.systemPackages = with pkgs; [
    lutris
    r2modman # mods
  ];
  systemd.settings.Manager.DefaultLimitNOFILE = 524288;
  security.pam = {
    loginLimits = [
      {
        domain = "${username}";
        type = "hard";
        item = "nofile";
        value = "524288";
      }
    ];
  };

}
