/// The words no agent station screen says (AS15, design-spec §6.6), plus the ones the app review
/// added: "campaign", "station", "disposition", "DNC", "Do Not Call", "outcome", "queue". The
/// console checks its station copy against the same list (`stationCopy.test.ts`).
final stationJargon = <RegExp>[
  RegExp('disposition', caseSensitive: false),
  RegExp(r'wrap-?up', caseSensitive: false),
  RegExp('pacing', caseSensitive: false),
  RegExp('session', caseSensitive: false),
  RegExp('station', caseSensitive: false),
  RegExp(r'\bSIP\b'),
  RegExp('webrtc', caseSensitive: false),
  RegExp(r'\bDNC\b'),
  RegExp(r'call-?back', caseSensitive: false),
  RegExp('campaign', caseSensitive: false),
  RegExp(r'\breserved\b', caseSensitive: false),
  RegExp(r'\bavailable\b', caseSensitive: false),
  RegExp(r'\boffline\b', caseSensitive: false),
  RegExp('reconnecting', caseSensitive: false),
  // The list's name; "Do not call them back" is plain words.
  RegExp('Do Not Call'),
  RegExp(r'\boutcomes?\b', caseSensitive: false),
  RegExp(r'\bqueue', caseSensitive: false),
];

/// The jargon [line] uses, by pattern; empty when it uses none.
List<String> jargonIn(String line) => [for (final w in stationJargon) if (w.hasMatch(line)) w.pattern];
