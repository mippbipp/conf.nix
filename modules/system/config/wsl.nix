# NixOS-WSL specific system config, shared by the WSL hosts.
{
  lib,
  ...
}:
{

  # useWindowsDriver symlinks the Windows GPU user-mode libs (libd3d12,
  # libdxcore, ...) into /run/opengl-driver/lib, but nothing puts them on
  # the dynamic linker path, so Mesa's d3d12 gallium driver can't dlopen
  # them. Exporting the real bind-mounted dir fixes that.
  # See nixos-wsl#454, microsoft/WSL#11293 (the boot-time dxgkio ioctl
  # errors are benign probe noise — GPU-PV works fine).
  wsl.useWindowsDriver = true;
  environment.sessionVariables = {
    LD_LIBRARY_PATH = [ "/usr/lib/wsl/lib" ];

    # Mesa >= 26 no longer auto-selects d3d12 on WSL, so GUI apps land on
    # llvmpipe (CPU) by default. Force the host iGPU: d3d12 exposes GL 4.1 /
    # GLES 3.0, enough for browsers and most GTK apps. Apps needing desktop
    # GL > 4.1 must opt out with GALLIUM_DRIVER=llvmpipe (GL 4.6). Zink over
    # Dozen is not an alternative here: it initializes, but WSLg has no
    # presentation path for it ("failed to create drisw screen").
    GALLIUM_DRIVER = "d3d12";

    # Cap llvmpipe's thread pool: uncapped, every repaint of a CPU-rendered
    # app fans out across all cores and starves everything else.
    LP_NUM_THREADS = "2";
  };

  # Ghostty needs desktop GL >= 4.3, more than d3d12 exposes, so pin it to
  # llvmpipe instead of letting it fail against the d3d12 default above.
  nixpkgs.overlays = [
    (final: prev: {
      ghostty = final.symlinkJoin {
        name = "${prev.ghostty.name}-llvmpipe";
        paths = [ prev.ghostty ];
        nativeBuildInputs = [ final.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/ghostty --set GALLIUM_DRIVER llvmpipe
        '';
        meta.mainProgram = "ghostty";
      };
    })
  ];

  # WSL2 kernel rejects the nft `fib` expression that reverse-path
  # filtering uses; override the "loose" that nixpkgs' tailscale
  # module sets for clients
  networking.firewall.checkReversePath = lib.mkForce false;
}
