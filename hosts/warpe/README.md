# wsl setup (work laptop)

* follow the shared WSL bootstrap: [WSL module](../../modules/system/config/wsl/README.md)
* the declarative CA trust config already lives in [work.nix](./work.nix); it stays inert until `company-root.pem` exists next to it (see step 3)
* tailscale: `sudo tailscale up --tun=userspace-networking` matching args in [tailscale config](../../modules/system/config/tailscale/default.nix)

## handling custom certs (work laptop)

### 1. Obtain the CA certificate

* get issuer name, modify channel to appropriate version in link in any of the commands, check value of `CN=` in `curl -vkI https://channels.nixos.org/nixos-26.05 2>&1 | grep -E 'subject:|issuer:|location:|SSL certificate verify'`
* replace `{X}` with a part of issuer name, probably matching company name, to search in windows:

  ```pwsh
  $stores = @(
    "Cert:\CurrentUser\Root",
    "Cert:\CurrentUser\CA",
    "Cert:\LocalMachine\Root",
    "Cert:\LocalMachine\CA"
  )

  foreach ($store in $stores) {
    Get-ChildItem $store -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Subject -match "{X}" -or
        $_.Issuer  -match "{X}"
      } |
      Select-Object Subject, Issuer, Thumbprint, NotAfter, PSPath
  }
  ```

* Find the best match for the certificate-inspection hierarchy, most likely first self-signed root, note `Thumbprint`
* Export cert to file, paste in `{Thumbprint}`:

  ```pwsh
  $cert = Get-ChildItem `
    "Cert:\CurrentUser\Root\{Thumbprint}"

  Export-Certificate `
    -Cert $cert `
    -FilePath "$env:USERPROFILE\Downloads\company-root.cer" `
    -Type CERT

  certutil -encode `
    "$env:USERPROFILE\Downloads\company-root.cer" `
    "$env:USERPROFILE\Downloads\company-root.pem"
  ```

* Copy into NixOS: `sudo cp /mnt/c/Users/<WindowsUser>/Downloads/company-root.pem /etc/nixos/company-root.pem`
* test in WSL:

  ```bash
  sudo sh -c \
  'cat /etc/ssl/certs/ca-certificates.crt \
       /etc/nixos/company-root.pem \
       > /etc/nixos/company-bundle.pem'

  curl \
    --cacert /etc/nixos/company-bundle.pem \
    -I https://channels.nixos.org/nixos-26.05
  ```

  * If you receive an HTTP response such as 301, 302, or 200, you have the correct root. The redirect is normal.
  * If it errors and there's another root in the powershell output above, try that instead.

### 2. Configure nix daemon

* `sudo cp /etc/nix/nix.conf /etc/nix/nix.conf.backup`
* Remove any existing `ssl-cert-file` setting, then add the working bundle:
  * `sudo sed -i '/^[[:space:]]*ssl-cert-file[[:space:]]*=/d' /etc/nix/nix.conf`
  * `printf '%s\n' \ 'ssl-cert-file = /etc/nixos/company-bundle.pem' | sudo tee -a /etc/nix/nix.conf`
  * `sudo systemctl restart nix-daemon.service 2>/dev/null || true`
  * `sudo systemctl restart nix-daemon.socket 2>/dev/null || true`
* `sudo nix-channel --update`

### 3. Make the trust configuration declarative

The trust block is already in the repo (`hosts/warpe/work.nix`); these steps only bootstrap nix until the first declarative rebuild reads it.

* Use the temporary bundle while running the first rebuild:

  ```bash
  sudo env \
    NIX_SSL_CERT_FILE=/etc/nixos/company-bundle.pem \
    SSL_CERT_FILE=/etc/nixos/company-bundle.pem \
    nixos-rebuild switch --flake .#warpe
  ```

* Test:
  * `curl --cacert /etc/ssl/certs/ca-certificates.crt --head --location https://channels.nixos.org/nixos-26.05`
  * with no temp env vars: `sudo nix-channel --update`
* rm old temporary bundle, but keep the `nix.settings.ssl-cert-file` added above (verify this):

  ```bash
  sudo sed -i \
    '/ssl-cert-file = \/etc\/nixos\/ca-bundle\.pem/d;
     /ssl-cert-file = \/etc\/nixos\/company-bundle\.pem/d' \
    /etc/nix/nix.conf
  ```

* Finally: `sudo nix-channel --update`
* Commit the pem into the repo so `work.nix` activates for later rebuilds:
  `sudo cp /etc/nixos/company-root.pem ~/conf.nix/hosts/warpe/company-root.pem` (as the base64 pem, then `git add` and `git commit`)
