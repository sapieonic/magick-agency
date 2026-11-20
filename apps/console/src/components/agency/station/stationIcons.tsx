import {
  CircleCheck,
  Coffee,
  Headphones,
  LogOut,
  MicOff,
  MonitorSmartphone,
  Pause,
  Phone,
  PhoneIncoming,
  TriangleAlert,
  VolumeX,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { TileIcon } from '@magick-agency/web-ui/components/TileIcon';
import type { BandIcon } from '../../../utils/agency/stationView';
import type { BreakIcon, OutcomeIcon } from '../../../utils/agency/stationTiles';

/** Every station picture is a lucide icon, `aria-hidden`: the words beside it carry the meaning. */
export const BAND_ICONS: Record<BandIcon, LucideIcon> = {
  headphones: Headphones,
  mic_off: MicOff,
  wifi_off: WifiOff,
  phone_in: PhoneIncoming,
  phone: Phone,
  check: CircleCheck,
  cup: Coffee,
  warning: TriangleAlert,
  pause: Pause,
  device: MonitorSmartphone,
  log_out: LogOut,
};

/**
 * A tile's picture: the shared picture (`TileIcon`, the same component campaign Settings' picker
 * draws) for every key it has, so agents see exactly what the supervisor picked; the station's
 * own two (`no_voice`, `phone`) for the guesses it has no shared picture for.
 */
const STATION_ONLY: Record<'no_voice' | 'phone', LucideIcon> = { no_voice: VolumeX, phone: Phone };

export function StationTileIcon({ icon, size }: { icon: OutcomeIcon | BreakIcon; size: number }) {
  if (icon === 'no_voice' || icon === 'phone') {
    const Icon = STATION_ONLY[icon];
    return <Icon size={size} aria-hidden="true" data-tile-icon={icon} />;
  }
  return <TileIcon icon={icon} size={size} />;
}
