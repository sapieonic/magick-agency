#
# To learn more about a Podspec see http://guides.cocoapods.org/syntax/podspec.html.
# Run `pod lib lint agent_audio.podspec` to validate before publishing.
#
Pod::Spec.new do |s|
  s.name             = 'agent_audio'
  s.version          = '0.0.1'
  s.summary          = 'Voice engine and CallKit integration for the Magick Agency agent app.'
  s.description      = <<-DESC
AVAudioEngine voice processing (echo cancellation), G.711 A-law / PCM16 framing, an adaptive
jitter buffer, audio routes and interruptions, and CallKit for outgoing calls.
                       DESC
  s.homepage         = 'http://example.com'
  s.license          = { :type => 'Proprietary', :text => 'Magick Agency. All rights reserved.' }
  s.author           = 'Magick Agency'
  s.source           = { :path => '.' }
  s.source_files = 'agent_audio/Sources/agent_audio/**/*'
  s.dependency 'Flutter'
  s.frameworks = 'AVFoundation', 'CallKit', 'UIKit'
  s.platform = :ios, '15.0'

  # Flutter.framework does not contain a i386 slice.
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version = '5.0'

  # If your plugin requires a privacy manifest, for example if it uses any
  # required reason APIs, update the PrivacyInfo.xcprivacy file to describe your
  # plugin's privacy impact, and then uncomment this line. For more information,
  # see https://developer.apple.com/documentation/bundleresources/privacy_manifest_files
  # s.resource_bundles = {'agent_audio_privacy' => ['agent_audio/Sources/agent_audio/PrivacyInfo.xcprivacy']}
end
