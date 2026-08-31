{
  pkgs,
  username,
  ...
}:
{
  environment = {
    sessionVariables = {
      LIBVIRT_DEFAULT_URI = "qemu:///system"; # attaches to system libvirtd daemon
      DOCKER_HOST = "unix://\${XDG_RUNTIME_DIR}/podman/podman.sock"; # use podman with dockerCompat
      ZSH_DISABLE_COMPFIX = "true"; # completions live in /nix/store so don't try to chmod them
    };
    systemPackages = with pkgs; [
      libvirt
      podman-compose
      distrobox
      lazydocker
      quickemu
      virt-viewer
    ];

    # expose nix binaries to distrobox containers
    etc."distrobox/distrobox.conf".text = ''
      container_additional_volumes="/nix/store:/nix/store:ro /etc/profiles/per-user:/etc/profiles/per-user:ro /etc/static/profiles/per-user:/etc/static/profiles/per-user:ro"
    '';

    # define isolated network for libvirt VMs
    etc."libvirt/qemu/networks/sandbox.xml".text = ''
      <network>
        <name>sandbox</name>
        <uuid>5c69bd94-c97d-48fb-b14b-1c3ebed8511c</uuid>
        <bridge name="virbr1" stp="on" delay="0"/>
        <ip address="192.168.210.1" netmask="255.255.255.0">
          <dhcp>
            <range start="192.168.210.2" end="192.168.210.254"/>
          </dhcp>
        </ip>
      </network>
    '';
  };
  programs.virt-manager.enable = true;

  systemd.services.libvirt-sandbox-net = {
    description = "Apply isolated libvirt network 'sandbox'";
    after = [
      "libvirtd.service"
      "libvirtd.socket"
    ];
    wants = [ "libvirtd.service" ];
    wantedBy = [ "multi-user.target" ];
    environment.LIBVIRT_DEFAULT_URI = "qemu:///system";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    path = [
      pkgs.libvirt
      pkgs.gnugrep
      pkgs.coreutils
    ];
    script = ''
      # Wait for libvirtd to be ready (socket activation can lag)
      for i in {1..30}; do
        if virsh --connect qemu:///system uri >/dev/null 2>&1; then
          break
        fi
        sleep 1
      done
      if ! virsh --connect qemu:///system net-info sandbox >/dev/null 2>&1; then
        virsh --connect qemu:///system net-define /etc/libvirt/qemu/networks/sandbox.xml
        virsh --connect qemu:///system net-autostart sandbox || true
      fi
      if ! virsh --connect qemu:///system net-info sandbox | grep -q "Active:.*yes"; then
        virsh --connect qemu:///system net-start sandbox || true
      fi
    '';
  };

  virtualisation = {
    containers.enable = true;
    libvirtd = {
      enable = true;
      qemu = {
        runAsRoot = false;
        swtpm.enable = true; # if guests need TPM support
        vhostUserPackages = [ pkgs.virtiofsd ]; # fs server for fast host dir to guest mounts
      };
    };
    podman = {
      enable = true;
      dockerCompat = true; # docker alias
      dockerSocket.enable = true; # routed to podman with DOCKER_HOST set above
      defaultNetwork.settings.dns_enabled = true; # containers can resolve each other's hostnames
    };
    oci-containers = {
      backend = "podman";
    };
  };
  users.extraUsers."${username}".extraGroups = [
    "kvm"
    "podman"
    "libvirt"
    "libvirtd"
  ];

  hardware.nvidia-container-toolkit.enable = true; # for podman
}
