package com.fidalix.fida_security

import android.content.Context
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class FidaSecurityPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private lateinit var channel: MethodChannel
    private lateinit var context: Context
    private var manager: StandardIntegrityManager? = null
    private var provider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        manager = IntegrityManagerFactory.createStandard(context)
        channel = MethodChannel(binding.binaryMessenger, "fida_security/attestation")
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        provider = null
        manager = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "prepareAndroidIntegrity" -> prepareIntegrity(call, result)
            "requestAndroidIntegrityToken" -> requestIntegrityToken(call, result)
            "iosIsAppAttestSupported",
            "iosGenerateKey",
            "iosAttestKey",
            "iosGenerateAssertion" -> result.error(
                "unsupported_platform",
                "Apple App Attest methods are available only on iOS.",
                null,
            )
            else -> result.notImplemented()
        }
    }

    private fun prepareIntegrity(call: MethodCall, result: MethodChannel.Result) {
        val rawProjectNumber = call.argument<Number>("cloudProjectNumber")
        val projectNumber = rawProjectNumber?.toLong()
        if (projectNumber == null || projectNumber <= 0L) {
            result.error(
                "invalid_cloud_project_number",
                "A positive Google Cloud project number is required.",
                null,
            )
            return
        }

        val request = StandardIntegrityManager.PrepareIntegrityTokenRequest.builder()
            .setCloudProjectNumber(projectNumber)
            .build()

        val integrityManager = manager
        if (integrityManager == null) {
            result.error("integrity_unavailable", "Play Integrity manager is unavailable.", null)
            return
        }

        integrityManager.prepareIntegrityToken(request)
            .addOnSuccessListener { preparedProvider ->
                provider = preparedProvider
                result.success(null)
            }
            .addOnFailureListener { error ->
                provider = null
                result.error(
                    "play_integrity_prepare_failed",
                    error.message ?: "Play Integrity preparation failed.",
                    error.javaClass.name,
                )
            }
    }

    private fun requestIntegrityToken(call: MethodCall, result: MethodChannel.Result) {
        val requestHash = call.argument<String>("requestHash")?.trim()
        if (requestHash.isNullOrEmpty() || requestHash.length > 500) {
            result.error(
                "invalid_request_hash",
                "Play Integrity requestHash must be non-empty and at most 500 characters.",
                null,
            )
            return
        }

        val preparedProvider = provider
        if (preparedProvider == null) {
            result.error(
                "integrity_provider_not_prepared",
                "Prepare Play Integrity before requesting a token.",
                null,
            )
            return
        }

        val request = StandardIntegrityManager.StandardIntegrityTokenRequest.builder()
            .setRequestHash(requestHash)
            .build()

        preparedProvider.request(request)
            .addOnSuccessListener { token -> result.success(token.token()) }
            .addOnFailureListener { error ->
                result.error(
                    "play_integrity_request_failed",
                    error.message ?: "Play Integrity request failed.",
                    error.javaClass.name,
                )
            }
    }
}
