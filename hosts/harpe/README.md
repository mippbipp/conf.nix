# wsl setup

* install steps at <https://nix-community.github.io/NixOS-WSL/install.html>
* `sudo nixos-rebuild edit`:
  ```
  environment.systemPackages = with pkgs; [ git neovim ];
   nix.settings.extra-experimental-features = [
     "nix-command"
     "flakes"
   ];
  ```
* follow <https://nix-community.github.io/NixOS-WSL/how-to/change-username.html>
* set NixOS as default distro to prevent startup errors (`wsl -s NixOS`)
  * can rm default `nixos` user dir 
* `ssh-keygen -t ed25519` with {host}_ed25519 as the filename, `ssh-add ~/.ssh/{host}_ed25519`, add pubkey to github 
* `nix-shell -p git neovim` -> `git clone --recurse-submodules --remote-submodules git@github.com:mippbipp/conf.nix.git`
* set username and hostname in `flake.nix` `nixosConfigurations.{hostname}`
  * if changing hostname, change folder's name in `hosts` folder
* change variables in `hosts/{hostname}/variables.nix`
* ensure all changes are tracked in git (e.g. `git add .`)
  * push, replace https remote with ssh remote in git and `.gitmodules`, etc
* `cd ~/conf.nix && sudo nixos-rebuild boot --flake .#{hostname}`
* pwsh: `wsl -t NixOS` -> `wsl -d NixOS --user root exit` -> `wsl -t NixOS` -> open WSL

## handling custom certs (e.g. work laptop)

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

* `sudo nixos-rebuild edit`
  ```nix
  security.pki.certificateFiles = [
    ./company-root.pem
  ];
  nix.settings = {
    ssl-cert-file = "/etc/ssl/certs/ca-certificates.crt";
    extra-sandbox-paths = [
      "/etc/ssl/certs/ca-certificates.crt"
    ];
  };
  systemd.services.nix-daemon.environment = {
    NIX_SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
    NIX_GIT_SSL_CAINFO = "/etc/ssl/certs/ca-certificates.crt";
    GIT_SSL_CAINFO = "/etc/ssl/certs/ca-certificates.crt";
  };
  ```
* Use the temporary bundle while running the first rebuild:
  ```bash
  sudo env \
    NIX_SSL_CERT_FILE=/etc/nixos/company-bundle.pem \
    SSL_CERT_FILE=/etc/nixos/company-bundle.pem \
    nixos-rebuild switch
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
* Then also add above nix block to actual wsl config, then delete all other added files used in temp commands.
