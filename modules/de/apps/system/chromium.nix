{ pkgs, ... }:
{
  environment.systemPackages = [
    pkgs.google-chrome
  ];
  programs.chromium = {
    enable = true;
    # Chrome Web Store IDs, force-installed. Keep in step with ExtensionSettings
    # in ../hm/zen/policies-config.nix. Chrome 157 has no uBlock Origin (Manifest
    # V2) or ClearURLs, so Ghostery stands in for both.
    extensions = [
      "mlomiejdfkolichcflejclcbmpeaniij" # Ghostery
      "nngceckbapebfimnlniiiahkandclblb" # Bitwarden
      "dbepggeogbaibhgnhhndojpepiihcmeb" # Vimium
      "kgcjekpmcjjogibpjebkhaanilehneje" # Karakeep
      "mfnicocicmmlkpjnaffgihfjhdgjkdjg" # browse
    ];
    extraOpts =
      # Chromium equivalents of ../hm/zen/policies-config.nix, where one exists.
      # https://chromeenterprise.google/policies/
      {
        AutofillAddressEnabled = true;
        AutofillCreditCardEnabled = false;
        # DisableFeedbackCommands
        UserFeedbackAllowed = false;
        FeedbackSurveysEnabled = false;
        # DisableFirefoxStudies. 1 keeps critical-fix variations; 2 blocks those too.
        ChromeVariations = 1;
        # DisableTelemetry
        MetricsReportingEnabled = false;
        UrlKeyedAnonymizedDataCollectionEnabled = false;
        DefaultBrowserSettingEnabled = false;
        # OfferToSaveLogins
        PasswordManagerEnabled = false;
        # EnableTrackingProtection and network.cookie.cookieBehavior
        BlockThirdPartyCookies = true;
        # SanitizeOnShutdown.Cache. Chromium can't turn the disk cache off.
        ClearBrowsingDataOnExitList = [ "cached_images_and_files" ];
        # browser.newtabpage.activity-stream.feeds.topsites
        NTPCardsVisible = false;
        # network.http.http3.enabled
        QuicAllowed = true;
        # gfx.webrender.all
        HardwareAccelerationModeEnabled = true;
      };
  };
}
