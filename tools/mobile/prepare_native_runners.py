from pathlib import Path

ANDROID_PERMISSIONS = """    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
"""

APPS = (
    ("apps/fida_rider", "Fida Ride"),
    ("apps/fida_driver", "Fida Driver"),
)

for app, label in APPS:
    manifest = Path(app) / "android/app/src/main/AndroidManifest.xml"
    manifest_text = manifest.read_text()
    if "android.permission.ACCESS_FINE_LOCATION" not in manifest_text:
        manifest_text = manifest_text.replace(
            "    <application",
            ANDROID_PERMISSIONS + "    <application",
            1,
        )
    manifest_text = manifest_text.replace(
        'android:label="fida_rider"',
        f'android:label="{label}"',
    )
    manifest_text = manifest_text.replace(
        'android:label="fida_driver"',
        f'android:label="{label}"',
    )
    manifest.write_text(manifest_text)

    plist = Path(app) / "ios/Runner/Info.plist"
    plist_text = plist.read_text()
    if "NSLocationWhenInUseUsageDescription" not in plist_text:
        plist_text = plist_text.replace(
            "</dict>\n</plist>",
            "  <key>NSLocationWhenInUseUsageDescription</key>\n"
            "  <string>Fida Ride uses your location to show your position and support trips.</string>\n"
            "</dict>\n</plist>",
        )
    plist.write_text(plist_text)
