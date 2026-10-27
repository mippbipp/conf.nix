# The Chrome for Testing headless shell T3 Code's preview browser runs.
# version and sha256 mirror the VERSION/ARCHIVES pin in t3code's
# apps/server/src/preview/PreviewBrowser.ts; the overlay fails the t3code
# build when upstream moves VERSION.
{
  lib,
  stdenv,
  fetchurl,
  unzip,
  autoPatchelfHook,
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  atk,
  dbus,
  expat,
  glib,
  libgbm,
  libx11,
  libxcb,
  libxcomposite,
  libxdamage,
  libxext,
  libxfixes,
  libxkbcommon,
  libxrandr,
  nspr,
  nss,
  systemd,
}:

let
  version = "154.0.8037.92";
  archives = {
    x86_64-linux = {
      platform = "linux64";
      sha256 = "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      sha256 = "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6";
    };
  };
  archive = archives.${stdenv.hostPlatform.system};
in
stdenv.mkDerivation {
  pname = "chrome-headless-shell";
  inherit version;

  # fetchurl, not fetchzip, so the hash is the zip's own SHA-256 that T3 pins
  src = fetchurl {
    url = "https://storage.googleapis.com/chrome-for-testing-public/${version}/${archive.platform}/chrome-headless-shell-${archive.platform}.zip";
    inherit (archive) sha256;
  };

  nativeBuildInputs = [
    autoPatchelfHook
    unzip
  ];

  buildInputs = [
    alsa-lib
    at-spi2-atk
    at-spi2-core
    atk
    dbus
    expat
    glib
    libgbm
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxkbcommon
    libxrandr
    nspr
    nss
    stdenv.cc.cc.lib
    systemd
  ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec
    cp -r . $out/libexec/chrome-headless-shell
    runHook postInstall
  '';

  passthru.executable = "libexec/chrome-headless-shell/chrome-headless-shell";

  meta = {
    description = "Chrome for Testing headless shell, as pinned by T3 Code";
    homepage = "https://googlechromelabs.github.io/chrome-for-testing/";
    license = lib.licenses.unfree;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = builtins.attrNames archives;
  };
}
