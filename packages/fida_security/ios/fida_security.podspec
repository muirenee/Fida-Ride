Pod::Spec.new do |s|
  s.name             = 'fida_security'
  s.version          = '0.1.0'
  s.summary          = 'Fida-Ride native device attestation bridge.'
  s.description      = 'Play Integrity and Apple App Attest bridge for Fida-Ride.'
  s.homepage         = 'https://fidalix.com'
  s.license          = { :type => 'Proprietary' }
  s.author           = { 'Fidalix Ltd' => 'info@fidalix.com' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'
  s.platform         = :ios, '14.0'
  s.frameworks       = 'DeviceCheck'
  s.swift_version    = '5.0'
end
