package main

import (
	"math"
	"testing"
)

func TestHaversineMetersZeroDistance(t *testing.T) {
	if got := haversineMeters(-1.9441, 30.0619, -1.9441, 30.0619); got != 0 {
		t.Fatalf("expected zero distance, got %f", got)
	}
}

func TestHaversineMetersKigaliScale(t *testing.T) {
	// Roughly 1 km north at Kigali latitude.
	got := haversineMeters(-1.9441, 30.0619, -1.9351, 30.0619)
	if math.Abs(got-1000) > 30 {
		t.Fatalf("expected approximately 1000m, got %.2fm", got)
	}
}

func TestParseTrustedTelemetryPoint(t *testing.T) {
	point, ok := parseTrustedTelemetryPoint([]any{"-1.9441", "30.0619", "1700000000000"})
	if !ok {
		t.Fatal("expected trusted telemetry point to parse")
	}
	if point.Latitude != -1.9441 || point.Longitude != 30.0619 || point.ObservedAtMS != 1700000000000 {
		t.Fatalf("unexpected point: %+v", point)
	}
}
