# warpe: work WSL host as a standalone copy of harpe

The work laptop runs its own NixOS-WSL guest (`warpe`) built from copies of harpe's host files plus `hosts/warpe/work.nix` for the company CA trust (`security.pki.certificateFiles`, nix `ssl-cert-file`, nix-daemon env vars). `work.nix` is guarded by `builtins.pathExists ./company-root.pem` so the flake stays evaluable on machines without the pem. The pem is committed plaintext — a CA root is public material distributed to every client, so sops would add key management with no confidentiality gain.

Considered and rejected: warpe importing `../harpe/config.nix` (couples two physical machines for ~35 lines of config that will diverge in both directions as work vs personal package choices differ), a shared WSL module in `modules/` (revisit only when a third WSL guest appears), and a runtime toggle for the cert config (a host is one physical machine; a toggle would let work certs leak into personal configs, and hostname-based detection breaks since both guests are named after their host folders).

Status: accepted
