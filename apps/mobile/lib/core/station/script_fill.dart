import 'package:agency_wire/agency_wire.dart' as wire;

/// What a script's placeholders say for the call on screen (BE-8); null leaves the placeholder
/// out (the line still shows).
typedef ScriptValues = ({
  String? name,
  String? place,
  String? amountDue,
  String? dueDate,
  String? agentName,
  String? campaignName,
});

/// A script line with its `{placeholders}` filled for the call on screen, by the contract's rule
/// (`fillScriptPlaceholders`: a `{word}` it does not know is left as it is). Here so the station
/// screens fill a line without reading the wire.
String fillScript(String text, ScriptValues v) => wire.fillScriptPlaceholders(text, (p) => switch (p) {
      wire.ScriptPlaceholder.name => v.name,
      wire.ScriptPlaceholder.place => v.place,
      wire.ScriptPlaceholder.amountDue => v.amountDue,
      wire.ScriptPlaceholder.dueDate => v.dueDate,
      wire.ScriptPlaceholder.agentName => v.agentName,
      wire.ScriptPlaceholder.campaignName => v.campaignName,
      wire.ScriptPlaceholder.unknown => null,
    });
