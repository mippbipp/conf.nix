# Gram runs three isolation tiers — containers, throwaway VMs, kept VMs

Gram is the machine for tasting distros and running untrusted binaries. Containers share the kernel and are wrong for that, VMs don't, and lifetime matters: throwaways should be deletable by removing a directory, keepers need a manager and snapshots. We keep all three, each in its tier.

- Container for trusted code and missing toolchains.
- Throwaway VM via quickemu for one-off runs with no daemon state.
- Kept VM via libvirtd and virt-manager with an isolated `sandbox` network for sketchy keepers.

One tool alone fails: libvirt makes throwaways heavy, quickemu has no snapshot UI or daemon, containers fail the isolation requirement. Alternatives like GNOME Boxes or microVMs add GNOME deps or only support Linux guests.

The module is gram-only. See `docs/vm-workflows.md` for per-guest choices.

Status: accepted
