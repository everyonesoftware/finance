#!/usr/bin/env bash
# Caller entry point: stage exactly one verified APK; never publish a release.
set +x
set -euo pipefail
export LC_ALL=C

fail() { printf '%s\n' "$*" >&2; exit 1; }
version=${RELEASE_VERSION:-}
source_sha=${GITHUB_SHA:-}
out=${RELEASE_ARTIFACT_DIR:-}
signing=${RELEASE_SIGNING_ENABLED:-}
[[ $signing == true || $signing == false ]] || fail 'RELEASE_SIGNING_ENABLED must be true or false.'
[[ $version =~ ^0\.1\.([1-9][0-9]{0,9})$ ]] || fail 'RELEASE_VERSION must be 0.1.N with a canonical positive patch.'
code=${BASH_REMATCH[1]}
(( code <= 2100000000 )) || fail 'Android versionCode out of range (1..2100000000).'
[[ $source_sha =~ ^[0-9a-f]{40}$ ]] || fail 'GITHUB_SHA must be a full lowercase Git SHA.'
[[ -n $out ]] || fail 'Set RELEASE_ARTIFACT_DIR.'
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
check_source() {
    [[ $(git -C "$root" rev-parse HEAD) == "$source_sha" ]] || fail 'GITHUB_SHA does not match HEAD.'
}
check_source

if [[ $signing == true ]]; then
    for name in RELEASE_KEYSTORE_BASE64 RELEASE_KEYSTORE_PASSWORD RELEASE_KEY_ALIAS RELEASE_KEY_PASSWORD; do
        [[ -n ${!name:-} ]] || fail "Missing $name."
    done
    variant=release
    apk_name=Finance-android-$version.apk
else
    variant=debug
    apk_name=Finance-android-$version-debug.apk
fi

sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[[ -n $sdk ]] || fail 'Set ANDROID_HOME or ANDROID_SDK_ROOT.'
tools=$sdk/build-tools/36.0.0
[[ -x $tools/apksigner && -x $tools/aapt ]] || fail 'Install Android SDK Build Tools 36.0.0.'
for name in "Finance-android-$version.apk" "Finance-android-$version-debug.apk"; do
    [[ ! -e $out/$name && ! -L $out/$name ]] || fail "APK already exists: $out/$name"
done

# The unsigned validation path must not consume release signing inputs, even if inherited.
unset RELEASE_KEYSTORE_PATH
work=
staged=
cleanup() {
    [[ -z $staged ]] || rm -f -- "$staged"
    [[ -z $work ]] || rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ $signing == true ]]; then
    work=$(umask 077; mktemp -d -- "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/finance-signing.XXXXXXXX")
    (umask 077; printf '%s' "$RELEASE_KEYSTORE_BASE64" | base64 --decode > "$work/release.keystore") \
        || fail 'Could not decode RELEASE_KEYSTORE_BASE64.'
    [[ -s $work/release.keystore ]] || fail 'The decoded release keystore is empty.'
    unset RELEASE_KEYSTORE_BASE64
    "${JAVA_HOME:+$JAVA_HOME/bin/}keytool" -exportcert -keystore "$work/release.keystore" \
        -storepass:env RELEASE_KEYSTORE_PASSWORD -alias "$RELEASE_KEY_ALIAS" -file "$work/release.der" >/dev/null
    expected=$(sha256sum < "$work/release.der")
    expected=${expected%% *}
fi

gradle=(bash "$root/android/gradlew" -p "$root/android" "-PfinanceReleaseVersion=$version"
    --no-daemon --no-configuration-cache --console=plain --max-workers=2)
validation=(:app:testDebugUnitTest :app:lintDebug)
if [[ $signing == false ]]; then validation+=(:app:assembleDebug); fi
(
    unset RELEASE_KEYSTORE_BASE64 RELEASE_KEYSTORE_PASSWORD RELEASE_KEY_ALIAS RELEASE_KEY_PASSWORD
    "${gradle[@]}" "${validation[@]}"
)
if [[ $signing == true ]]; then
    RELEASE_KEYSTORE_PATH="$work/release.keystore" "${gradle[@]}" :app:assembleRelease
    rm -rf -- "$work"
    work=
fi
unset RELEASE_KEYSTORE_BASE64 RELEASE_KEYSTORE_PASSWORD RELEASE_KEY_ALIAS RELEASE_KEY_PASSWORD
check_source

# Verify the exact staged bytes, then expose them atomically and without overwriting a file.
mkdir -p -- "$out"
staged=$(mktemp -- "$out/.finance-android.XXXXXXXX.apk")
cp -- "$root/android/app/build/outputs/apk/$variant/app-$variant.apk" "$staged"
badging=$("$tools/aapt" dump badging "$staged")
package_line=${badging%%$'\n'*}
[[ $package_line == "package: name='com.everyonesoftware.finance' versionCode='$code' versionName='$version'"* ]] \
    || fail 'APK package or version mismatch.'
report=$("$tools/apksigner" verify --print-certs "$staged")
if [[ $signing == true ]]; then
    [[ $badging != *application-debuggable* ]] || fail 'Release APK is debuggable.'
    actual=$(awk '/^Signer #[0-9]+ certificate SHA-256 digest: / {print $NF}' <<< "$report")
    [[ $actual == "$expected" ]] || fail 'Release APK signer does not match the configured key.'
    if grep -Eq '^Signer #[0-9]+ certificate DN: ([^,]+, *)*CN=Android Debug(,|$)' <<< "$report"; then
        fail 'The Android debug signer cannot be used for a release.'
    fi
else
    [[ $badging == *application-debuggable* ]] || fail 'Expected a debug validation APK.'
fi
ln -T -- "$staged" "$out/$apk_name" || fail "Could not stage $out/$apk_name."
printf 'Staged %s APK for %s: %s\n' "$variant" "$source_sha" "$out/$apk_name"
