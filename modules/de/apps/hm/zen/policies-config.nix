let
  mkLockedAttrs = builtins.mapAttrs (
    _: value: {
      Value = value;
      Status = "locked";
    }
  );
in
{
  AutofillAddressEnabled = true;
  AutofillCreditCardEnabled = false;
  # Zen ships its own NSS root store and ignores /etc/ssl/certs, so WSL
  # hosts behind TLS interception can't reach sites like
  # addons.mozilla.org without importing the system bundle explicitly.
  Certificates.Install = [ "/etc/ssl/certs/ca-certificates.crt" ];
  DisableAppUpdate = true;
  DisableFeedbackCommands = true;
  DisableFirefoxStudies = true;
  DisablePocket = false; # save webs for later reading
  DisableTelemetry = true;
  DontCheckDefaultBrowser = true;
  NoDefaultBookmarks = true;
  OfferToSaveLogins = false;
  # Keyed by add-on ID, valued by its addons.mozilla.org slug. Keep in step with
  # programs.chromium.extensions in ../../system/chromium.nix.
  ExtensionSettings =
    builtins.mapAttrs
      (_: slug: {
        install_url = "https://addons.mozilla.org/firefox/downloads/latest/${slug}/latest.xpi";
        installation_mode = "force_installed";
      })
      {
        "uBlock0@raymondhill.net" = "ublock-origin";
        "{446900e4-71c2-419f-a6a7-df9c091e268b}" = "bitwarden-password-manager";
        "{d7742d87-e61d-4b78-b8a1-b469842139fa}" = "vimium-ff";
        "{74145f27-f039-47ce-a470-a662b129930a}" = "clearurls";
        "addon@karakeep.app" = "karakeep";
      };
  EnableTrackingProtection = {
    Value = true;
    Locked = true;
    Cryptomining = true;
    Fingerprinting = true;
  };
  SanitizeOnShutdown = {
    FormData = true;
    Cache = true;
  };
  Preferences = mkLockedAttrs {
    "browser.aboutConfig.showWarning" = false;
    "browser.cache.disk.enable" = false;
    "browser.cache.memory.enable" = true;
    "browser.cache.memory.capacity" = 1000000; # 1 MB

    "media.videocontrols.picture-in-picture.video-toggle.enabled" = true;
    "browser.tabs.hoverPreview.enabled" = true;
    "browser.newtabpage.activity-stream.feeds.topsites" = false;
    "browser.topsites.contile.enabled" = false;

    "privacy.resistFingerprinting" = true;
    "privacy.firstparty.isolate" = true;
    "privacy.resistFingerprinting.randomization.canvas.use_siphash" = true;
    "privacy.resistFingerprinting.randomization.daily_reset.enabled" = true;
    "privacy.resistFingerprinting.randomization.daily_reset.private.enabled" = true;
    "privacy.resistFingerprinting.block_mozAddonManager" = true;
    "privacy.spoof_english" = 1;
    "network.cookie.cookieBehavior" = 5;
    "dom.battery.enabled" = false;

    "gfx.webrender.all" = true;
    "network.http.http3.enabled" = true;
    "network.protocol-handler.expose.raycast" = true; # raycast / vicinae links (e.g. auth)
  };
}
