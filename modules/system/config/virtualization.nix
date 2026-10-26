{
  lib,
  pkgs,
  username,
  ...
}:
let
  # Declarative libvirt networks. Each entry becomes an /etc XML definition plus
  # a oneshot unit (below) that defines, autostarts, and starts it, so a fresh
  # machine has the network before any guest needs it.
  libvirtNetworks = {
    # Isolated network: no <forward>, so guests reach each other but not the
    # host LAN or the internet. For throwaway VMs.
    sandbox = ''
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
    # NAT network: guests reach the internet through the host. This replaces the
    # stock libvirt "default" network, now declared here so it is reproducible
    # instead of living as imperative state under /var/lib. UUID and MAC are
    # pinned so the definition is deterministic across machines.
    default = ''
      <network>
        <name>default</name>
        <uuid>10b5c7e1-cc5e-489a-a11b-88220f33e707</uuid>
        <forward mode="nat"/>
        <bridge name="virbr0" stp="on" delay="0"/>
        <mac address="52:54:00:c2:b3:23"/>
        <ip address="192.168.122.1" netmask="255.255.255.0">
          <dhcp>
            <range start="192.168.122.2" end="192.168.122.254"/>
          </dhcp>
        </ip>
      </network>
    '';
  };

  libvirtNetworkEtc = lib.mapAttrs' (
    name: xml: lib.nameValuePair "libvirt/qemu/networks/${name}.xml" { text = xml; }
  ) libvirtNetworks;

  # One oneshot unit per network. Ride along with libvirtd instead of pulling it
  # in: keying off libvirtd.service (not multi-user.target) keeps a network only
  # throwaway VMs need off the critical path to graphical.target, while still
  # guaranteeing it is defined before any guest can need it, because anything
  # that talks to libvirt starts the daemon first.
  mkNetUnit = name: {
    description = "Apply libvirt network '${name}'";
    after = [
      "libvirtd.service"
      "libvirtd.socket"
    ];
    wantedBy = [ "libvirtd.service" ];
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
      if ! virsh --connect qemu:///system net-info ${name} >/dev/null 2>&1; then
        virsh --connect qemu:///system net-define /etc/libvirt/qemu/networks/${name}.xml
      fi
      # Reassert autostart and active state every boot; both are idempotent and
      # cover networks that were defined outside this unit.
      virsh --connect qemu:///system net-autostart ${name} || true
      if ! virsh --connect qemu:///system net-info ${name} | grep -q "Active:.*yes"; then
        virsh --connect qemu:///system net-start ${name} || true
      fi
    '';
  };
in
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
    etc = {
      "distrobox/distrobox.conf".text = ''
        container_additional_volumes="/nix/store:/nix/store:ro /etc/profiles/per-user:/etc/profiles/per-user:ro /etc/static/profiles/per-user:/etc/static/profiles/per-user:ro"
      '';
    }
    # define libvirt VM networks
    // libvirtNetworkEtc;
  };
  programs.virt-manager.enable = true;

  systemd.services = {
    # libvirtd.socket is WantedBy=sockets.target, so the socket is already
    # listening at boot and nixpkgs' own multi-user.target membership is
    # redundant. Dropping it hands the daemon start to whoever first
    # connects (virt-manager, virsh, or quickemu).
    libvirtd.wantedBy = lib.mkForce [ ];

    # Generating the CDI spec costs boot time and blocks on
    # `udevadm settle` waiting for GPU device nodes that are usually not needed
    # yet. The unit is already `requiredBy podman.service`, so dropping it from
    # multi-user.target leaves it running on first container start instead.
    nvidia-container-toolkit-cdi-generator.wantedBy = lib.mkForce [ ];
  }
  # One libvirt-<name>-net oneshot per declared network.
  // lib.mapAttrs' (
    name: _: lib.nameValuePair "libvirt-${name}-net" (mkNetUnit name)
  ) libvirtNetworks;

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
