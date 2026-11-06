# Hosts are declared statically in flake.nix; the fleet registry describes them

`flake.nix` declares each host once in a literal list, `nixpkgs.lib.genAttrs [ "gram" … ] (host: mkHostConfig { inherit host; })`. The fleet registry (`modules/fleet/registry.nix`) carries everything another machine might need to know about an already-declared host. A line exists because *this* machine is something (uses `${host}`) or because it points *at* some other machine (reads Globals, meaning `config.fleet.hosts` in NixOS modules or the merged `globals` argument in Home Manager). Declaration sites are neither.

Generating `nixosConfigurations` from the registry's host names was considered and rejected. Generation would mean `builtins.listToAttrs` over an imported file, and the literal list keeps the declaration evaluable and grep-able in `flake.nix`. Adding a host touches two files: the list in `flake.nix` and the host's registry record. Role flags then select their own implementations from the record (ADR-0020), and the `fleet-correspondence` flake check fails if a declared host has no record.

Status: accepted
