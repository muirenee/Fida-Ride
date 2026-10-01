import DeviceCheck
import Flutter
import Foundation

public final class FidaSecurityPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(
      name: "fida_security/attestation",
      binaryMessenger: registrar.messenger()
    )
    let instance = FidaSecurityPlugin()
    registrar.addMethodCallDelegate(instance, channel: channel)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "iosIsAppAttestSupported":
      result(DCAppAttestService.shared.isSupported)

    case "iosGenerateKey":
      guard DCAppAttestService.shared.isSupported else {
        result(
          FlutterError(
            code: "app_attest_unsupported",
            message: "Apple App Attest is not supported on this device.",
            details: nil
          )
        )
        return
      }

      DCAppAttestService.shared.generateKey { keyId, error in
        DispatchQueue.main.async {
          if let error {
            result(
              FlutterError(
                code: "app_attest_generate_key_failed",
                message: error.localizedDescription,
                details: String(describing: error)
              )
            )
            return
          }
          guard let keyId, !keyId.isEmpty else {
            result(
              FlutterError(
                code: "app_attest_empty_key_id",
                message: "App Attest returned an empty key identifier.",
                details: nil
              )
            )
            return
          }
          result(keyId)
        }
      }

    case "iosAttestKey":
      guard
        let arguments = call.arguments as? [String: Any],
        let keyId = arguments["keyId"] as? String,
        let hashBase64 = arguments["clientDataHashBase64"] as? String,
        let clientDataHash = Data(base64Encoded: hashBase64),
        clientDataHash.count == 32
      else {
        result(
          FlutterError(
            code: "invalid_app_attest_arguments",
            message: "keyId and a 32-byte clientDataHash are required.",
            details: nil
          )
        )
        return
      }

      DCAppAttestService.shared.attestKey(keyId, clientDataHash: clientDataHash) {
        attestation, error in
        DispatchQueue.main.async {
          if let error {
            result(
              FlutterError(
                code: "app_attest_attestation_failed",
                message: error.localizedDescription,
                details: String(describing: error)
              )
            )
            return
          }
          guard let attestation else {
            result(
              FlutterError(
                code: "app_attest_empty_attestation",
                message: "App Attest returned no attestation object.",
                details: nil
              )
            )
            return
          }
          result(attestation.base64EncodedString())
        }
      }

    case "iosGenerateAssertion":
      guard
        let arguments = call.arguments as? [String: Any],
        let keyId = arguments["keyId"] as? String,
        let hashBase64 = arguments["clientDataHashBase64"] as? String,
        let clientDataHash = Data(base64Encoded: hashBase64),
        clientDataHash.count == 32
      else {
        result(
          FlutterError(
            code: "invalid_app_attest_arguments",
            message: "keyId and a 32-byte clientDataHash are required.",
            details: nil
          )
        )
        return
      }

      DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: clientDataHash) {
        assertion, error in
        DispatchQueue.main.async {
          if let error {
            result(
              FlutterError(
                code: "app_attest_assertion_failed",
                message: error.localizedDescription,
                details: String(describing: error)
              )
            )
            return
          }
          guard let assertion else {
            result(
              FlutterError(
                code: "app_attest_empty_assertion",
                message: "App Attest returned no assertion object.",
                details: nil
              )
            )
            return
          }
          result(assertion.base64EncodedString())
        }
      }

    case "prepareAndroidIntegrity", "requestAndroidIntegrityToken":
      result(
        FlutterError(
          code: "unsupported_platform",
          message: "Play Integrity methods are available only on Android.",
          details: nil
        )
      )

    default:
      result(FlutterMethodNotImplemented)
    }
  }
}
