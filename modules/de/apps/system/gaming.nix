{ pkgs, ... }:
{
  # Needed For Some Steam Games
  boot.kernel.sysctl = {
    "vm.max_map_count" = 2147483642;
  };
  programs.steam = {
    enable = true;
    gamescopeSession = {
      enable = true;
      # Offload carve-out, ticket #183 / ADR-0003: the gamescope session is an
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

  environment.systemPackages = with pkgs; [
    r2modman # mods
  ];
}
