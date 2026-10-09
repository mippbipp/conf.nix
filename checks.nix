# Fleet-wide gate checks, one per supported system.
# Wired as `checks` in flake.nix.
{
  nixpkgs,
  nixosConfigurations,
  globals,
}:
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
    username = globals.user.name;
    # Evaluated alone, so Role flags stay readable without building a host.
    records =
      (nixpkgs.lib.evalModules { modules = [ ./modules/fleet/registry.nix ]; }).config.fleet.hosts;
    hosts = builtins.filter (h: !(records ? ${h}) || !records.${h}.external) (
      builtins.attrNames nixosConfigurations
    );
    cfgOf = host: nixosConfigurations.${host}.config;
    hmOf = host: (cfgOf host).home-manager.users.${username};
    assertRole =
      {
        name,
        flag,
        present,
        subject,
      }:
      let
        offenders = builtins.filter (h: present h != records.${h}.${flag}) hosts;
        summarise = builtins.map (h: "${h}: ${subject}=${builtins.toJSON (present h)}") offenders;
      in
      if offenders == [ ] then
        pkgs.runCommand name { } "touch $out"
      else
        throw "${flag} mismatch on ${builtins.toJSON offenders}: ${builtins.concatStringsSep ", " summarise}";
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
        records =
          (nixpkgs.lib.evalModules { modules = [ ./modules/fleet/registry.nix ]; }).config.fleet.hosts;
        declared = builtins.attrNames nixosConfigurations;
        missing = builtins.filter (h: !(records ? ${h}) || records.${h}.external) declared;
        liveRecords = nixpkgs.lib.filterAttrs (_: r: !r.external) records;
        phantom = builtins.filter (h: !(builtins.elem h declared)) (builtins.attrNames liveRecords);
      in
      if missing == [ ] && phantom == [ ] then
        pkgs.runCommand "fleet-correspondence" { } "touch $out"
      else
        throw "fleet registry mismatch: missing records for ${builtins.toString missing}; phantom records for ${builtins.toString phantom}";
    # Locks in strictness: a typo'd Role flag and a mistyped flag
    # must both fail evaluation, so the registry can never silently
    # regress to `or false` semantics.
    fleet-strictness =
      let
        evalBad =
          extra:
          builtins.tryEval (
            builtins.deepSeq
              (nixpkgs.lib.evalModules {
                modules = [
                  ./modules/fleet/registry.nix
                  { fleet.hosts.strictness-probe = extra; }
                ];
              }).config.fleet.hosts
              false
          );
      in
      if !(evalBad { isExitNod = true; }).success && !(evalBad { isExitNode = "yes"; }).success then
        pkgs.runCommand "fleet-strictness" { } "touch $out"
      else
        throw "fleet registry is not strict: typo'd Role flag or wrong type evaluated successfully";
    # The Build gate matrix is control-plane-adjacent YAML outside this
    # flake's references, so pin it by parsing instead: every declared
    # host's system must be covered by exactly one per-arch `build <system>`
    # job, and every arch job must have at least one host. Hosts are
    # enumerated from the flake at CI time, so adding a host of an
    # already-covered arch needs no workflow edit. This check fails the
    # gate when a host's arch has no job (or a job covers nothing).
    build-matrix-sync =
      let
        gate = builtins.readFile ./.github/workflows/build-gate.yml;
        # Scope to the build-closure job: the checks job below has its own
        # `- system:` rows over the same systems.
        closureSection = builtins.head (nixpkgs.lib.splitString "\n  checks:" gate);
        matrixSystems = nixpkgs.lib.unique (
          nixpkgs.lib.concatMap (
            line:
            let
              m = builtins.match " *- system: ([a-z0-9_.-]+) *" line;
            in
            if m == null then [ ] else m
          ) (nixpkgs.lib.splitString "\n" closureSection)
        );
        hostSystems = nixpkgs.lib.mapAttrs (_: c: c.config.nixpkgs.hostPlatform.system) nixosConfigurations;
        declared = builtins.attrNames nixosConfigurations;
        uncovered = builtins.filter (h: !(builtins.elem hostSystems.${h} matrixSystems)) declared;
        usedSystems = nixpkgs.lib.unique (builtins.attrValues hostSystems);
        phantom = builtins.filter (s: !(builtins.elem s usedSystems)) matrixSystems;
      in
      if uncovered == [ ] && phantom == [ ] then
        pkgs.runCommand "build-matrix-sync" { } "touch $out"
      else
        throw "build gate matrix mismatch: hosts without an arch job ${builtins.toJSON uncovered}; arch jobs without hosts ${builtins.toJSON phantom}";
    # A flag set without its implementation builds fine and fails at runtime, so
    # each one is checked against the built config.
    work-identity-wiring = assertRole {
      name = "work-identity-wiring";
      flag = "usesWorkGit";
      subject = "work git include";
      # Probed on the Home Manager side: NixOS sops.secrets stays empty until
      # secrets/work.yaml is provisioned, so it cannot tell "flag off" from
      # "file missing". Both transports are asserted so neither drops alone.
      present =
        h:
        let
          hm = hmOf h;
        in
        (builtins.any (i: i.condition == "gitdir:~/work/") hm.programs.git.includes)
        && builtins.length hm.programs.ssh.includes > 0;
    };
    sshd-wiring =
      let
        # Port too: the firewall and the listen port both come from sshPort, so a
        # host setting services.openssh.ports locally would otherwise pass.
        present =
          h:
          let
            o = (cfgOf h).services.openssh;
          in
          o.enable && o.ports == [ records.${h}.sshPort ];
      in
      assertRole {
        name = "sshd-wiring";
        flag = "acceptsSsh";
        subject = "sshd enabled on the record's port";
        inherit present;
      };
    personal-secrets-wiring = assertRole {
      name = "personal-secrets-wiring";
      flag = "isPersonalHost";
      subject = "personal secrets";
      # git_config is the oldest personal secret.
      present = h: (cfgOf h).sops.secrets ? git_config;
    };
    checkout-wiring = assertRole {
      name = "checkout-wiring";
      flag = "hasRepoCheckout";
      subject = "nrs installed";
      # nrs builds from ~/conf.nix, so a host without one must not carry a command
      # pointing at a directory that does not exist.
      present = h: builtins.any (p: (p.name or "") == "nrs") (hmOf h).home.packages;
    };
    # The Build gate YAML is control-plane-adjacent text outside this flake's
    # references, so pin it by parsing instead: every extra-substituters /
    # extra-trusted-public-keys row must equal the globals.cache derivation in
    # order (substituter order is a performance decision), and the push step
    # must reference the same endpoint and cache name. Nix-side consumers
    # (nix.nix, attic.nix, nrs) interpolate globals.cache directly
    # and are correct by construction, so only YAML is asserted here.
    attic-cache-sync =
      let
        inherit (globals) cache;
        gate = builtins.readFile ./.github/workflows/build-gate.yml;
        lines = nixpkgs.lib.splitString "\n" gate;
        collect =
          prefix:
          nixpkgs.lib.concatMap (
            line:
            let
              m = builtins.match "^ *${prefix} =(.*)$" line;
            in
            if m == null then [ ] else m
          ) lines;
        splitWords = s: builtins.filter (w: w != "") (nixpkgs.lib.splitString " " s);
        subRows = map splitWords (collect "extra-substituters");
        keyRows = map splitWords (collect "extra-trusted-public-keys");
        # Word-exact (not substring): a suffixed typo like cache:fleets must fail.
        # Scoped to the push-step lines so a stray mention in a YAML comment
        # cannot satisfy the check while the real step drifts.
        pushLines = builtins.filter (line: builtins.match "^ *attic (login|push) .*" line != null) lines;
        pushWords = nixpkgs.lib.concatMap splitWords pushLines;
        subsOk = subRows != [ ] && builtins.all (row: row == cache.substituters) subRows;
        keysOk = keyRows != [ ] && builtins.all (row: row == cache.trustedKeys) keyRows;
        pushOk =
          pushLines != [ ]
          && builtins.elem cache.endpoint pushWords
          && builtins.elem "cache:${cache.cacheName}" pushWords;
      in
      if subsOk && keysOk && pushOk then
        pkgs.runCommand "attic-cache-sync" { } "touch $out"
      else
        throw "attic cache sync mismatch: extra-substituters rows ${builtins.toJSON subRows} (expected ${builtins.toJSON cache.substituters}); extra-trusted-public-keys rows match=${builtins.toString keysOk}; push endpoint+cache ref present=${builtins.toString pushOk}";
  }
)
