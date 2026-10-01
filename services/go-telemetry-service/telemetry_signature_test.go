package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestCanonicalTelemetryPayload(t *testing.T) {
	packet := TelemetryPacket{
		DriverID:  "driver-1",
		Latitude:  -1.9441,
		Longitude: 30.0619,
		Bearing:   125,
		Status:    "available",
		SessionID: "session-1",
		Timestamp: 1790845010000,
		Sequence:  1,
	}

	want := "v1\nsession-1\ndriver-1\n-1.9441000\n30.0619000\n125.00\navailable\n1790845010000\n1"
	if got := canonicalTelemetryPayload(packet); got != want {
		t.Fatalf("canonical payload mismatch\nwant: %q\n got: %q", want, got)
	}
}

func TestCanonicalTelemetryHMACVector(t *testing.T) {
	key := make([]byte, 32)
	for index := range key {
		key[index] = byte(index)
	}

	packet := TelemetryPacket{
		DriverID:  "driver-1",
		Latitude:  -1.9441,
		Longitude: 30.0619,
		Bearing:   125,
		Status:    "available",
		SessionID: "session-1",
		Timestamp: 1790845010000,
		Sequence:  1,
	}

	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(canonicalTelemetryPayload(packet)))
	got := hex.EncodeToString(mac.Sum(nil))
	const want = "08a4960abb7583d9d4f4a78d7d9f435ecabd96f7ac9b6df367cbc61974ce6701"
	if got != want {
		t.Fatalf("signature mismatch: want %s got %s", want, got)
	}
}
