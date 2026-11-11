import type { Appointment } from './api/types';

export function statusText({ status, confirmedBy, cancelledBy }: Appointment): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'confirmed':
      return confirmedBy === 'staff' ? 'Confirmed by staff' : 'Confirmed by client';
    case 'cancelled':
      return cancelledBy === 'staff' ? 'Cancelled by staff' : 'Cancelled by client';
    case 'attended':
      return 'Attended';
    case 'no_show':
      return 'No-show';
  }
}
