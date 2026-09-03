# Fleet-wide gate checks, one per supported system.
#
# Interface: a function of nixpkgs, the declared NixOS hosts, and the plain
# Globals data (currently only nextdns). Wired once as `checks` in flake.nix.
{ nixpkgs, nixosConfigurations, globals }:
let
  systems = [
    "x86_64-linux"
    "aarch64-linux"
  ];
in
nixpkgs.lib.genAttrs systems (
  system:
  let
    pkgs = nixpkgs.legacyPackages.${system};
    profile = globals.nextdns.id;
    profHi = builtins.substring 0 2 profile;
    profLo = builtins.substring 2 4 profile;
    sentinel = "2a07:a8c0::${profHi}:${profLo}";
  in
  {
    # The Tailnet policy file is control-plane state outside this
    # flake's evaluation, so the NextDNS profile cannot be shared by
    # reference. Fail the gate instead when the two sides drift.
    # Patterns are quoted HCL strings so prose comments mentioning
    # the profile cannot satisfy them; the sentinel pins the full
    # NextDNS linked address (prefix is NextDNS address space).
    dns-profile-sync = pkgs.runCommand "dns-profile-sync" { } ''
      tf=${./terraform/tailscale/main.tf}
      grep -Fq '"nextdns:${profile}"' "$tf" || (echo "nodeAttrs profile mismatch: globals.nextdns.id ${profile} absent from Tailnet policy file" >&2; exit 1)
      grep -Fq '"${sentinel}"' "$tf" || (echo "sentinel mismatch: expected profile-linked IPv6 ${sentinel} in Tailnet policy file" >&2; exit 1)
      touch $out
    '';
    # Every NixOS host has a live fleet record and every live
    # record names a declared host. External peers (no NixOS
    # declaration) are exempt on the record side only.
    fleet-correspondence =
      let
        records = (nixpkgs.lib.evalModules { modules = [ ./modules/fleet.nix ]; }).config.fleet.hosts;
        declared = builtins.attrNames nixosConfigurations;
        missing = builtins.filter (h: !(records ? ${h}) || records.${h}.external) declared;
        liveRecords = nixpkgs.lib.filterAttrs (_: r: !r.external) records;
        phantom = builtins.filter (h: !(builtins.elem h declared)) (builtins.attrNames liveRecords);
      in
      if missing == [ ] && phantom == [ ] then
        pkgs.runCommand "fleet-correspondence" { } ''touch $out''
      else
        throw "fleet registry mismatch: missing records for ${builtins.toString missing}; phantom records for ${builtins.toString phantom}";
    # Locks in strictness: a typo'd Role flag and a mistyped flag
    # must both fail evaluation, so the registry can never silently
    # regress to `or false` semantics.
    fleet-strictness =
      let
        evalBad = extra: builtins.tryEval (builtins.deepSeq (nixpkgs.lib.evalModules {
          modules = [ ./modules/fleet.nix { fleet.hosts.strictness-probe = extra; } ];
        }).config.fleet.hosts false);
      in
      if !(evalBad { isExitNod = true; }).success && !(evalBad { isExitNode = "yes"; }).success then
        pkgs.runCommand "fleet-strictness" { } ''touch $out''
      else
        throw "fleet registry is not strict: typo'd Role flag or wrong type evaluated successfully";
    # The Build gate matrix is control-plane-adjacent YAML outside this
    # flake's references, so pin it by parsing instead: every declared
    # host needs one `- host:` matrix row and vice versa. Fail the gate
    # when a host addition forgets either side.
    build-matrix-sync =
      let
        gate = builtins.readFile ./.github/workflows/build-gate.yml;
        matrixHosts = nixpkgs.lib.concatMap (
          line:
          let
            m = builtins.match " *- host: ([a-z0-9-]+) *" line;
          in
          if m == null then [ ] else m
        ) (nixpkgs.lib.splitString "\n" gate);
        declared = builtins.attrNames nixosConfigurations;
        missing = builtins.filter (h: !(builtins.elem h matrixHosts)) declared;
        phantom = builtins.filter (h: !(builtins.elem h declared)) matrixHosts;
      in
      if missing == [ ] && phantom == [ ] then
        pkgs.runCommand "build-matrix-sync" { } ''touch $out''
      else
        throw "build gate matrix mismatch: missing rows for ${builtins.toString missing}; phantom rows for ${builtins.toString phantom}";
  }
)
