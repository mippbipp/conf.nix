# Hosts are declared statically in flake.nix; Globals describes them

`flake.nix` declares each host once in a literal list, `nixpkgs.lib.genAttrs [ "gram" … ] (host: mkHostConfig { inherit host; })`. The host records in Globals (`hosts` in `modules/globals.nix`) carry everything another machine might need to know about an already-declared host. A line exists because *this* machine is something (uses `${host}`) or because it points *at* some other machine (reads `globals.hosts`, in NixOS and Home Manager alike). Declaration sites are neither.

Generating `nixosConfigurations` from the host records' names was considered and rejected. Generation would mean `builtins.listToAttrs` over an imported file, and the literal list keeps the declaration evaluable and grep-able in `flake.nix`. Adding a host touches two files: the list in `flake.nix` and the host's record in `modules/globals.nix`. Role flags then select their own implementations from the record (ADR-0020), and the `fleet-correspondence` flake check fails if a declared host has no record.

Status: accepted
