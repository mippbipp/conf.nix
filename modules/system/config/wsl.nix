# NixOS-WSL specific system config, shared by the WSL hosts.
{
  lib,
  ...
}:
{
  wsl.useWindowsDriver = true;

  # useWindowsDriver symlinks the Windows GPU user-mode libs (libd3d12,
  # libdxcore, ...) into /run/opengl-driver/lib, but nothing puts them on
  # the dynamic linker path, so Mesa's d3d12 gallium driver can't dlopen
  # them and every GL app silently falls back to llvmpipe. Exporting the
  # real bind-mounted dir makes GL run on the host GPU.
  # See nixos-wsl#454, microsoft/WSL#11293 (the boot-time dxgkio ioctl
  # errors are benign probe noise — GPU-PV works fine).
  environment.sessionVariables.LD_LIBRARY_PATH = [ "/usr/lib/wsl/lib" ];

  # The d3d12 driver only exposes GL 4.1 here (ghostty needs >= 4.3), so
  # GL apps run on llvmpipe. Cap its thread pool: uncapped, every terminal
  # repaint fans out across all cores and starves everything else.
  environment.sessionVariables.LP_NUM_THREADS = "2";

  # WSL2 kernel rejects the nft `fib` expression that reverse-path
  # filtering uses; override the "loose" that nixpkgs' tailscale
  # module sets for clients
  networking.firewall.checkReversePath = lib.mkForce false;
}
