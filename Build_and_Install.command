#!/bin/bash
# Tab Triage: build the app from source and install it.
# Double-click in Finder, or run it in Terminal.
#
# Needs: Xcode (free, Mac App Store) with your Apple ID added in Xcode > Settings > Accounts.
# A free Apple ID works. The app is signed with your own Apple Development certificate, so Safari
# keeps Tab Triage turned on like any other extension.
#
# Optional settings (put them before the command, e.g. TEAM_ID=ABCDE12345 ./Build_and_Install.command):
#   TEAM_ID=ABCDE12345           sign with this team (default: the first Apple Development certificate)
#   BUNDLE_ID=com.you.tabtriage  app id; the extension is BUNDLE_ID.Extension (default: made from your team)
#   INSTALL_DIR=/some/folder     where the app goes (default: ~/Applications)
#   UNSIGNED=1                   build without signing (Safari then needs "Allow Unsigned Extensions"
#                                after every launch)
#   NO_INSTALL=1 OUT_DIR=/path   build only and leave a zip in OUT_DIR (used for releases)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$HERE/extension" ]; then
  # Repository layout: scripts at the top, extension/ and native/ beside them.
  ROOT="$HERE"; EXT="$ROOT/extension"; NATIVE="$ROOT/native"; WORK="$ROOT/build"
  DEFAULT_INSTALL="$HOME/Applications"; LAYOUT=repo
else
  # Project layout: this script in 04_Build_Tools/, everything stays inside the project folder.
  ROOT="$(cd "$HERE/.." && pwd)"; EXT="$ROOT/02_Extension_Code"; NATIVE="$HERE/native"
  WORK="$ROOT/99_Build_Workspace.nosync"   # ".nosync" = iCloud skips it
  DEFAULT_INSTALL="$ROOT/01_App"; LAYOUT=project
fi
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL}"
APP_NAME="Tab Triage"
MIN_MACOS="11.0"
XPROJ="$WORK/xcode_project"
# iCloud Drive re-tags every .app/.appex folder with Finder info, which codesign rejects
# ("resource fork, Finder information, or similar detritus not allowed"). So compile and sign on a
# small disk image that lives in WORK and is mounted inside WORK, where iCloud doesn't touch it.
IMG="$WORK/build_volume.sparseimage"
VOL="$WORK/build_volume"
DERIVED="$VOL/xcode_build"

die()  { echo; echo "ERROR: $*" >&2; exit 1; }
note() { echo "   $*"; }

# ---------------------------------------------------------------------------------------------
# 0. Prerequisites
# ---------------------------------------------------------------------------------------------
[ -f "$EXT/manifest.json" ] || die "Can't find the extension code next to this script. Download the whole project, not just this file."
[ "$(uname)" = "Darwin" ] || die "Tab Triage builds on a Mac only."

if ! xcode-select -p 2>/dev/null | grep -q "Xcode"; then
  if [ -d /Applications/Xcode.app ]; then
    die "Xcode is installed but not selected. In Terminal, run:
   sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
Then run this script again."
  fi
  die "Xcode isn't installed. Get it free from the Mac App Store:
   https://apps.apple.com/app/xcode/id497799835
Open it once to finish setup, then run this script again."
fi
xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1 \
  || die "Xcode needs to finish setting up. In Terminal, run:
   sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
Then run this script again."

# Apple renamed the converter to "packager"; try the new name, fall back to the old one.
if xcrun --find safari-web-extension-packager >/dev/null 2>&1; then TOOL=safari-web-extension-packager
elif xcrun --find safari-web-extension-converter >/dev/null 2>&1; then TOOL=safari-web-extension-converter
else die "This Xcode has no Safari web extension packager. Update Xcode from the App Store."; fi

# Signing team: your Apple Development certificate (created by Xcode once your Apple ID is added).
TEAM="${TEAM_ID:-}"
if [ -z "${UNSIGNED:-}" ] && [ -z "$TEAM" ]; then
  TEAM="$(security find-certificate -a -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1 || true)"
  if [ -z "$TEAM" ]; then
    echo "No Apple Development certificate on this Mac yet. To make one (free, about a minute):"
    echo "  1. Open Xcode > Settings > Accounts, click +, choose Apple ID and sign in."
    echo "  2. Select your team (\"Personal Team\" for a free Apple ID), click Manage Certificates,"
    echo "     click + and choose Apple Development."
    echo "  3. Run this script again."
    echo
    if [ -t 0 ]; then
      read -r -p "Or build an unsigned copy now? Safari will need \"Allow Unsigned Extensions\" after every launch. [y/N] " ans
      case "$ans" in y|Y|yes|YES) UNSIGNED=1 ;; *) exit 1 ;; esac
    else
      exit 1
    fi
  fi
fi
[ -n "${UNSIGNED:-}" ] && TEAM=""

# App id: unique per signing team, so anyone's free Apple ID can sign it.
if [ -n "${BUNDLE_ID:-}" ]; then BUNDLE="$BUNDLE_ID"
elif [ -z "$TEAM" ] || [ "$TEAM" = "KFT88Q5XQ9" ]; then BUNDLE="com.joshhotz.tabtriage"   # unsigned builds and the author's own
else BUNDLE="com.tabtriage.t$(printf '%s' "$TEAM" | tr 'A-Z' 'a-z')"; fi

# ---------------------------------------------------------------------------------------------
# 1. Generate the Xcode project from the extension
# ---------------------------------------------------------------------------------------------
mkdir -p "$WORK"
[ "$LAYOUT" = project ] && rm -rf "$WORK/xcode_build"   # in-iCloud build folder left by older versions

detach_vol() { hdiutil detach -quiet "$VOL" 2>/dev/null || hdiutil detach -quiet -force "$VOL" 2>/dev/null || true; }
detach_vol   # clear a mount left by an interrupted run
[ -f "$IMG" ] || hdiutil create -quiet -size 4g -type SPARSE -fs APFS -volname TabTriageBuild "$IMG" \
  || die "Couldn't create the build disk image."
mkdir -p "$VOL"
hdiutil attach -quiet -nobrowse -noautoopen -owners on -mountpoint "$VOL" "$IMG" \
  || die "Couldn't mount the build disk image."
trap detach_vol EXIT

rm -rf "$XPROJ" "$DERIVED"   # only ever deletes generated build folders inside WORK
mkdir -p "$XPROJ"

echo "1/4 Generating the Xcode project ($BUNDLE)"
xcrun "$TOOL" "$EXT" --project-location "$XPROJ" --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE" --macos-only --swift --no-open --no-prompt --force >/dev/null

PROJ="$(find "$XPROJ" -maxdepth 3 -name '*.xcodeproj' | head -1)"
[ -n "$PROJ" ] || die "No Xcode project was generated."
# Newer packagers apply --bundle-identifier to the extension only and name the app from --app-name
# (e.g. com.joshhotz.Tab-Triage), which fails "embedded binary is not prefixed with the parent app's
# bundle identifier". Force the app target to $BUNDLE so the extension ($BUNDLE.Extension) nests under it.
sed -i '' -E "/\.Extension;/!s/(PRODUCT_BUNDLE_IDENTIFIER = )[^;]+;/\1$BUNDLE;/" "$PROJ/project.pbxproj"
grep -q "PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE;" "$PROJ/project.pbxproj" \
  || die "Couldn't set the app id to $BUNDLE."

# Our own files over the packager's stubs. App-side files are found outside the extension folder.
app_file() {   # app_file <name> -> path of the packager's copy in the app target
  find "$XPROJ" -name "$1" -not -path '*/xcuserdata/*' -not -path '*Extension/*' -not -path '*.xcodeproj/*' | head -1
}
replace_file() {   # replace_file <name> <our copy>
  local dst; dst="$(app_file "$1")"
  [ -n "$dst" ] && [ -f "$2" ] || die "Couldn't replace $1 in the generated project."
  cp "$2" "$dst"
}
HANDLER_DST="$(find "$XPROJ" -name SafariWebExtensionHandler.swift -not -path '*/xcuserdata/*' | head -1)"
[ -f "$NATIVE/SafariWebExtensionHandler.swift" ] && [ -n "$HANDLER_DST" ] || die "Couldn't install the native handler."
cp "$NATIVE/SafariWebExtensionHandler.swift" "$HANDLER_DST"          # Usage button (Safari-wide memory/CPU)
for f in ViewController.swift Main.html Script.js Style.css Icon.png; do  # guided-setup window
  replace_file "$f" "$NATIVE/app/$f"
done
ICONSET="$(find "$XPROJ" -type d -name AppIcon.appiconset -not -path '*Extension/*' | head -1)"
[ -n "$ICONSET" ] || die "Couldn't find the app icon set in the generated project."
rm -f "$ICONSET"/*; cp "$NATIVE/app/AppIcon.appiconset/"* "$ICONSET/"
# Finder category and copyright, in the app's own Info.plist when the project has one.
APP_PLIST="$(find "$XPROJ" -name Info.plist -not -path '*Extension/*' -not -path '*/xcuserdata/*' -not -path '*.xcodeproj/*' | head -1)"
if [ -n "$APP_PLIST" ]; then
  plutil -replace LSApplicationCategoryType -string "public.app-category.productivity" "$APP_PLIST" || true
  plutil -replace NSHumanReadableCopyright -string "© $(date +%Y) hotz." "$APP_PLIST" || true
fi

SCHEME="$(xcodebuild -list -project "$PROJ" 2>/dev/null \
  | awk '/Schemes:/{f=1;next} f&&NF{sub(/^[ \t]+/,"");print}' | grep -vi 'extension' | head -1 || true)"
[ -n "$SCHEME" ] || die "Couldn't find the app scheme in $PROJ."

# ---------------------------------------------------------------------------------------------
# 2. Build: universal (Apple Silicon + Intel), macOS 11 and later
# ---------------------------------------------------------------------------------------------
if [ -n "$TEAM" ]; then
  echo "2/4 Building, signed with team $TEAM"
  SIGN=(DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates)
else
  echo "2/4 Building unsigned"
  SIGN=(CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=)
fi
# App version = manifest version; build number = date.time, so every build is newer than the last.
VERSION="$(plutil -extract version raw -o - "$EXT/manifest.json" 2>/dev/null || echo 1.0)"
BUILD_NUM="$(date +%Y%m%d).$(date +%H%M%S)"
xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Release \
  -derivedDataPath "$DERIVED" "${SIGN[@]}" \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUM" \
  ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS" \
  INFOPLIST_KEY_LSApplicationCategoryType="public.app-category.productivity" \
  INFOPLIST_KEY_NSHumanReadableCopyright="© $(date +%Y) hotz." \
  -quiet build \
  || die "The build failed (details above). If it mentions signing: open Xcode > Settings > Accounts and check
your Apple ID is signed in, then run this again. Last resort: open $PROJ in Xcode,
set Signing > Team on both targets and press Cmd-R."

BUILT="$(find "$DERIVED/Build/Products/Release" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$BUILT" ] || die "The build finished but no app came out."
codesign --verify --deep --strict "$BUILT" || die "Signature check failed on the built app."
ARCHS_OUT="$(lipo -archs "$BUILT/Contents/MacOS/$APP_NAME" 2>/dev/null || true)"
case "$ARCHS_OUT" in *arm64*x86_64*|*x86_64*arm64*) note "Universal: $ARCHS_OUT" ;;
  *) die "Expected a universal app (arm64 + x86_64), got: ${ARCHS_OUT:-unknown}" ;; esac
# macOS registers every app it sees; forget the copy on the build volume so Safari only ever
# finds the installed one (a second registration made Safari list Tab Triage twice).
pluginkit -r "$BUILT/Contents/PlugIns/$APP_NAME Extension.appex" >/dev/null 2>&1 || true

if [ -n "${NO_INSTALL:-}" ]; then
  OUT_DIR="${OUT_DIR:-$WORK/out}"; mkdir -p "$OUT_DIR"
  ZIP="$OUT_DIR/Tab-Triage-$VERSION.zip"
  rm -f "$ZIP"; ditto -c -k --keepParent "$BUILT" "$ZIP"
  echo; echo "Built: $ZIP ($VERSION, build $BUILD_NUM, $ARCHS_OUT)"
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# 3. Install
# ---------------------------------------------------------------------------------------------
echo "3/4 Installing into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
APP_PATH="$INSTALL_DIR/$APP_NAME.app"
for other in "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app"; do
  if [ "$other" != "$APP_PATH" ] && [ -d "$other" ]; then
    note "Note: another copy is at $other. Move it to the Trash so Safari doesn't see two."
  fi
done
# Swap the new app in atomically, so the installed app is never missing or half-copied.
# Safari re-registers the extension ~10 s after any rebuild and may drop its toolbar button;
# settings survive. The toolbar check below reports it.
STAGE="$WORK/install_stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$BUILT" "$STAGE/$APP_NAME.app"
osascript -e "tell application id \"$BUNDLE\" to quit" >/dev/null 2>&1 || true   # the old app, if running
if [ -d "$APP_PATH" ]; then
  # Atomic swap (renamex_np RENAME_SWAP); falls back to a copy across volumes.
  python3 -c 'import ctypes,sys; c=ctypes.CDLL(None, use_errno=True); sys.exit(0 if c.renamex_np(sys.argv[1].encode(), sys.argv[2].encode(), 2) == 0 else 1)' \
    "$STAGE/$APP_NAME.app" "$APP_PATH" 2>/dev/null || rsync -a --delete "$BUILT/" "$APP_PATH/" || die "Couldn't update $APP_PATH."
else
  ditto "$STAGE/$APP_NAME.app" "$APP_PATH"
fi
rm -rf "$STAGE"   # the previous build, swapped out
codesign --verify --deep "$APP_PATH" || die "The installed app failed its signature check."
if [ "$LAYOUT" = project ]; then
  rm -f "$INSTALL_DIR/Tab_Triage_app_backup.zip"
  ditto -c -k --keepParent "$BUILT" "$INSTALL_DIR/Tab_Triage_app_backup.zip"   # from the clean copy on the build volume
fi

# ---------------------------------------------------------------------------------------------
# 4. Register with Safari: opening the app registers the extension and shows the setup guide
# ---------------------------------------------------------------------------------------------
echo "4/4 Opening Tab Triage"
open "$APP_PATH"

# Toolbar check: after Safari re-registers the extension, is the Tab Triage button still on the toolbar?
# Read-only look at Safari's saved toolbar layout.
TOOLBAR=unknown
if [ -n "$TEAM" ] && pgrep -xq Safari; then
  note "Waiting for Safari to pick up the new build..."
  sleep 20
  TOOLBAR="$(defaults export "$HOME/Library/Containers/com.apple.Safari/Data/Library/Preferences/com.apple.Safari" - 2>/dev/null \
    | python3 -c 'import plistlib, sys
try:
    d = plistlib.loads(sys.stdin.buffer.read())
except Exception:
    print("unknown"); sys.exit()
bars = [v.get("TB Item Identifiers", []) for k, v in d.items() if k.startswith("NSToolbar Configuration Browser") and isinstance(v, dict)]
print("unknown" if not bars else ("ok" if all(sys.argv[1] in b for b in bars) else "missing"))' \
      "WebExtension-$BUNDLE.Extension ($TEAM)" 2>/dev/null || echo unknown)"
fi

echo
echo "Done. Installed: $APP_PATH ($VERSION, build $BUILD_NUM, $ARCHS_OUT)"
case "$TOOLBAR" in
  ok)      echo "Toolbar: the Tab Triage button is in place." ;;
  missing) echo "Toolbar: Safari took the Tab Triage button off the toolbar during the update."
           echo "         Put it back: Safari > Settings > Extensions, untick Tab Triage, then tick it again." ;;
esac
echo "The Tab Triage window walks you through turning it on in Safari."
[ "$LAYOUT" = project ] && echo "In Finder: right-click 01_App > Keep Downloaded."
[ -z "$TEAM" ] && echo "Unsigned build: Safari needs Develop > Allow Unsigned Extensions after every launch."
exit 0
