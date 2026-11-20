import 'package:flutter/material.dart';

import '../../../core/station/station_view.dart';

/// A supervisor's tile picture (BE-13) as the phone draws it.
IconData tilePictureIcon(TilePicture p) => switch (p) {
      TilePicture.rupee => Icons.currency_rupee,
      TilePicture.clock => Icons.schedule,
      TilePicture.calendar => Icons.event_outlined,
      TilePicture.stop => Icons.block,
      TilePicture.thumbsUp => Icons.thumb_up_outlined,
      TilePicture.thumbsDown => Icons.thumb_down_outlined,
      TilePicture.check => Icons.check_circle_outline,
      TilePicture.cross => Icons.cancel_outlined,
      TilePicture.phoneMissed => Icons.phone_missed_outlined,
      TilePicture.phoneBusy => Icons.phone_locked_outlined,
      TilePicture.voicemail => Icons.voicemail,
      TilePicture.wrongNumber => Icons.phone_disabled_outlined,
      TilePicture.language => Icons.translate,
      TilePicture.question => Icons.help_outline,
      TilePicture.tea => Icons.free_breakfast_outlined,
      TilePicture.lunch => Icons.restaurant_outlined,
      TilePicture.washroom => Icons.wc,
      TilePicture.meeting => Icons.groups_outlined,
      TilePicture.training => Icons.school_outlined,
      TilePicture.prayer => Icons.self_improvement,
      TilePicture.headset => Icons.headset_mic_outlined,
      TilePicture.walk => Icons.directions_walk,
      TilePicture.person => Icons.person_outline,
      TilePicture.dot => Icons.radio_button_unchecked,
    };
