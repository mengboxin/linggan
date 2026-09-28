import { Eraser as EraserIcon, Redo2, Undo2 } from 'lucide-react'
import type { SVGProps } from 'react'

export type StableIconName =
  | 'account_tree'
  | 'add'
  | 'arrow_back'
  | 'arrow_forward'
  | 'auto_awesome'
  | 'brush'
  | 'campaign'
  | 'chevron_left'
  | 'chevron_right'
  | 'chevron_up'
  | 'check_circle'
  | 'close'
  | 'content_copy'
  | 'compare'
  | 'dashboard_customize'
  | 'drag_handle'
  | 'move'
  | 'dark_mode'
  | 'edit'
  | 'eraser'
  | 'error'
  | 'expand'
  | 'favorite'
  | 'history'
  | 'image'
  | 'image_search'
  | 'info'
  | 'layers'
  | 'light_mode'
  | 'loader'
  | 'magic_wand'
  | 'notifications'
  | 'pan'
  | 'palette'
  | 'poster'
  | 'play_arrow'
  | 'refresh'
  | 'select_area'
  | 'send'
  | 'search'
  | 'science'
  | 'slideshow'
  | 'swap'
  | 'swap_horiz'
  | 'delete_sweep'
  | 'draw'
  | 'open_in_full'
  | 'target'
  | 'thumb_up'
  | 'toll'
  | 'tune'
  | 'undo'
  | 'redo'
  | 'upload_image'
  | 'download'
  | 'zoom_in'
  | 'person'
  | 'view_carousel'
  | 'visibility_off'

interface StableIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: StableIconName
  filled?: boolean
  title?: string
}

function strokeProps(strokeWidth = 2) {
  return {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth,
  }
}

export function StableIcon({ name, filled = false, title, className = '', ...props }: StableIconProps) {
  const labelled = Boolean(title)
  const lucideClassName = `inline-block shrink-0 align-[-0.125em] ${className}`

  if (name === 'undo' || name === 'redo' || name === 'eraser') {
    const HistoryIcon = name === 'undo' ? Undo2 : name === 'redo' ? Redo2 : EraserIcon
    return (
      <HistoryIcon
        size="1em"
        strokeWidth={2}
        aria-hidden={labelled ? undefined : true}
        aria-label={title}
        role={labelled ? 'img' : undefined}
        className={lucideClassName}
        {...props}
      />
    )
  }

  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      className={`inline-block shrink-0 align-[-0.125em] ${className}`}
      {...props}
    >
      {title && <title>{title}</title>}
      {name === 'arrow_back' && <path {...strokeProps()} d="M19 12H5m7 7-7-7 7-7" />}
      {name === 'arrow_forward' && <path {...strokeProps()} d="M5 12h14m-7-7 7 7-7 7" />}
      {name === 'add' && <path {...strokeProps(2.2)} d="M12 5v14M5 12h14" />}
      {name === 'history' && (
        <>
          <path {...strokeProps()} d="M4.4 8.2A8.5 8.5 0 1 1 4 15m.4-6.8V3.8m0 4.4h4.4" />
          <path {...strokeProps()} d="M12 7.5V12l3.2 2" />
        </>
      )}
      {name === 'play_arrow' && <path {...strokeProps(1.9)} d="m8 5 10 7-10 7V5Z" />}
      {name === 'refresh' && <path {...strokeProps()} d="M19 8V4m0 4h-4M5 16v4m0-4h4m9.1-6A7 7 0 0 0 6.3 7.3L5 9m14 6-1.3 1.7A7 7 0 0 1 5.9 14" />}
      {name === 'download' && <path {...strokeProps(2)} d="M12 3v11m-4-4 4 4 4-4M5 17v3h14v-3" />}
      {name === 'zoom_in' && (
        <>
          <circle {...strokeProps()} cx="10.5" cy="10.5" r="6.5" />
          <path {...strokeProps()} d="m15.5 15.5 5 5M10.5 7.5v6m-3-3h6" />
        </>
      )}
      {name === 'image_search' && (
        <>
          <rect {...strokeProps()} x="3" y="4" width="14" height="14" rx="2.5" />
          <path {...strokeProps()} d="m5.5 15 3.5-3.5 2.7 2.4 1.6-1.6 2.3 2.1" />
          <circle {...strokeProps(1.8)} cx="16.8" cy="16.8" r="3.2" />
          <path {...strokeProps(1.8)} d="m19.2 19.2 2 2" />
        </>
      )}
      {name === 'drag_handle' && (
        <>
          <circle fill="currentColor" cx="8" cy="7" r="1.4" />
          <circle fill="currentColor" cx="16" cy="7" r="1.4" />
          <circle fill="currentColor" cx="8" cy="12" r="1.4" />
          <circle fill="currentColor" cx="16" cy="12" r="1.4" />
          <circle fill="currentColor" cx="8" cy="17" r="1.4" />
          <circle fill="currentColor" cx="16" cy="17" r="1.4" />
        </>
      )}
      {name === 'move' && (
        <>
          <path {...strokeProps(1.9)} d="M12 2v20M2 12h20" />
          <path {...strokeProps(1.9)} d="m12 2-3 3m3-3 3 3m-3 17-3-3m3 3 3-3M2 12l3-3m-3 3 3 3m17-3-3-3m3 3-3 3" />
        </>
      )}
      {name === 'chevron_left' && <path {...strokeProps(2.4)} d="m15 18-6-6 6-6" />}
      {name === 'chevron_right' && <path {...strokeProps(2.4)} d="m9 6 6 6-6 6" />}
      {name === 'chevron_up' && <path {...strokeProps(2.4)} d="m18 15-6-6-6 6" />}
      {name === 'close' && <path {...strokeProps(2.2)} d="M6 6l12 12M18 6 6 18" />}
      {name === 'search' && <path {...strokeProps()} d="M11 19a8 8 0 1 1 5.66-2.34L21 21" />}
      {name === 'target' && (
        <>
          <circle {...strokeProps()} cx="12" cy="12" r="6" />
          <path {...strokeProps()} d="M12 2v3m0 14v3M2 12h3m14 0h3" />
          <circle fill="currentColor" cx="12" cy="12" r="1.7" />
        </>
      )}
      {name === 'brush' && (
        <>
          <path {...strokeProps()} d="m14.6 4.1 5.3 5.3M4.2 19.8l2.6-.6 10.8-10.8a1.9 1.9 0 0 0-2.7-2.7L4.1 16.5l.1 3.3Z" />
          <path {...strokeProps()} d="M3.8 20.2c.7.7 2 .7 2.7 0" />
        </>
      )}
      {name === 'select_area' && (
        <>
          <rect {...strokeProps()} x="4" y="4" width="16" height="16" rx="2" strokeDasharray="2.5 2.5" />
          <path {...strokeProps()} d="M9 9h6v6H9z" />
        </>
      )}
      {name === 'expand' && <path {...strokeProps(2.2)} d="M8 3H3v5m0-5 6 6m7-6h5v5m0-5-6 6M8 21H3v-5m0 5 6-6m7 6h5v-5m0 5-6-6" />}
      {name === 'upload_image' && (
        <>
          <rect {...strokeProps()} x="3" y="5" width="18" height="14" rx="3" />
          <path {...strokeProps()} d="m5.5 16 4-4 2.7 2.5 2-2 3.8 3.5M15 4V1m-3 3 3-3 3 3" />
        </>
      )}
      {name === 'tune' && (
        <>
          <path {...strokeProps()} d="M4 7h16M4 17h16M9 3v8m6 2v8" />
          <circle fill="currentColor" cx="9" cy="7" r="2" />
          <circle fill="currentColor" cx="15" cy="17" r="2" />
        </>
      )}
      {name === 'send' && <path {...strokeProps(2.1)} d="m3 11 18-8-8 18-2.2-7.8L3 11Zm7.8 2.2L21 3" />}
      {name === 'loader' && <circle {...strokeProps(2.5)} cx="12" cy="12" r="8" strokeDasharray="14 36" />}
      {name === 'magic_wand' && (
        <>
          <path {...strokeProps(2.1)} d="m4.5 19.5 11-11M6.4 13.5l4.1 4.1" />
          <path {...strokeProps(1.8)} d="m16.2 3.2.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8.8-2.1ZM19.5 12.6l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4.4-1.1Z" />
        </>
      )}
      {name === 'layers' && (
        <>
          <path {...strokeProps()} d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path {...strokeProps()} d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </>
      )}
      {name === 'swap' && <path {...strokeProps()} d="M5 8h12l-3-3m3 3-3 3M19 16H7l3 3m-3-3 3-3" />}
      {name === 'swap_horiz' && <path {...strokeProps(2)} d="M4 8h15m-4-4 4 4-4 4M20 16H5m4 4-4-4 4-4" />}
      {name === 'delete_sweep' && (
        <>
          <path {...strokeProps(2)} d="M5 7h14m-8-3h2m-7 3 1 13h10l1-13" />
          <path {...strokeProps(1.8)} d="M9 11v5m3-5v5m3-5v5" />
        </>
      )}
      {name === 'draw' && <path {...strokeProps(2)} d="m4 20 3.6-.8L19 7.8a2 2 0 0 0-2.8-2.8L4.8 16.4 4 20Zm9.7-13.7 2.8 2.8" />}
      {name === 'open_in_full' && <path {...strokeProps(2)} d="M8 3H3v5m0-5 6 6m7-6 5 0v5m0-5-6 6M8 21H3v-5m0 5 6-6m7 6h5v-5m0 5-6-6" />}
      {name === 'palette' && (
        <>
          <path {...strokeProps()} d="M12 3a9 9 0 1 0 0 18h1.5a1.5 1.5 0 0 0 0-3H13a1.5 1.5 0 0 1 0-3h3a6 6 0 0 0-4-12Z" />
          <circle fill="currentColor" cx="7.5" cy="11" r="1" />
          <circle fill="currentColor" cx="10.5" cy="7.5" r="1" />
          <circle fill="currentColor" cx="14.5" cy="8.5" r="1" />
        </>
      )}
      {name === 'edit' && <path {...strokeProps()} d="m4 20 3.5-.8L19 7.7a2 2 0 0 0-2.8-2.8L4.8 16.4 4 20Zm9.7-13.7 2.8 2.8" />}
      {name === 'notifications' && (
        <>
          <path {...strokeProps()} d="M18 9a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path {...strokeProps()} d="M10 21a2.2 2.2 0 0 0 4 0" />
        </>
      )}
      {name === 'campaign' && (
        <>
          <path {...strokeProps()} d="M4 13h3l9 4V5L7 9H4a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2Z" />
          <path {...strokeProps()} d="m7 13 1 6h3l-1.4-5.2M19 8.5l2-1.2M19 13.5l2 1.2" />
        </>
      )}
      {name === 'check_circle' && (
        <>
          <circle {...strokeProps()} cx="12" cy="12" r="9" />
          <path {...strokeProps()} d="m8 12.4 2.4 2.4L16.5 9" />
        </>
      )}
      {name === 'error' && (
        <>
          <circle {...strokeProps()} cx="12" cy="12" r="9" />
          <path {...strokeProps()} d="M12 7v6m0 4h.01" />
        </>
      )}
      {name === 'info' && (
        <>
          <circle {...strokeProps()} cx="12" cy="12" r="9" />
          <path {...strokeProps()} d="M12 11v6m0-10h.01" />
        </>
      )}
      {name === 'toll' && (
        <>
          <circle {...strokeProps()} cx="12" cy="12" r="8" />
          <path {...strokeProps()} d="M9 10.2c.8-.9 1.8-1.4 3-1.4 1.8 0 3 .9 3 2.3 0 3-6 1.5-6 4.1 0 1.2 1.2 2 3 2 1.3 0 2.4-.4 3.2-1.2M12 7v10" />
        </>
      )}
      {name === 'pan' && (
        <path {...strokeProps(1.8)} d="M8 11V5.5a1.5 1.5 0 0 1 3 0v3m0-2a1.5 1.5 0 0 1 3 0v2m0-1a1.5 1.5 0 0 1 3 0v2m0-1a1.5 1.5 0 0 1 3 0v5.5a5 5 0 0 1-5 5h-2.4a5 5 0 0 1-3.6-1.5L5 15.2a1.8 1.8 0 0 1 2.6-2.5L8 13" />
      )}
      {name === 'person' && (
        <>
          <circle {...strokeProps()} cx="12" cy="8" r="3.4" />
          <path {...strokeProps()} d="M5 20a7 7 0 0 1 14 0" />
        </>
      )}
      {name === 'light_mode' && (
        <>
          <path {...strokeProps()} d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41" />
          <circle {...strokeProps()} cx="12" cy="12" r="4" />
        </>
      )}
      {name === 'dark_mode' && (
        <path
          fill="currentColor"
          d="M20.3 15.1A8.6 8.6 0 0 1 8.9 3.7a8.6 8.6 0 1 0 11.4 11.4Z"
        />
      )}
      {name === 'dashboard_customize' && (
        <>
          <rect {...strokeProps()} x="3" y="4" width="7" height="7" rx="2" />
          <rect {...strokeProps()} x="14" y="4" width="7" height="7" rx="2" />
          <rect {...strokeProps()} x="3" y="15" width="7" height="5" rx="2" />
          <path {...strokeProps()} d="M17.5 15v6m-3-3h6" />
        </>
      )}
      {name === 'image' && (
        <>
          <rect {...strokeProps()} x="3" y="5" width="18" height="14" rx="3" />
          <circle {...strokeProps()} cx="8.5" cy="9.5" r="1.4" />
          <path {...strokeProps()} d="m5.5 16 4.2-4 3.2 3 2.1-2 3.5 3" />
        </>
      )}
      {name === 'science' && (
        <>
          <path {...strokeProps()} d="M10 3h4m-3 0v5.7l-5.8 9.4A2 2 0 0 0 6.9 21h10.2a2 2 0 0 0 1.7-2.9L13 8.7V3" />
          <path {...strokeProps()} d="M8 16h8" />
          <circle fill="currentColor" cx="10" cy="18" r="0.8" />
          <circle fill="currentColor" cx="14" cy="17" r="0.8" />
        </>
      )}
      {name === 'poster' && (
        <>
          <rect {...strokeProps()} x="5" y="3" width="14" height="18" rx="2.5" />
          <path {...strokeProps()} d="M8 8h8M8 12h5M8 16h8" />
          <path {...strokeProps()} d="M16 3v4h3" />
        </>
      )}
      {name === 'slideshow' && (
        <>
          <rect {...strokeProps()} x="3" y="5" width="18" height="13" rx="2.5" />
          <path {...strokeProps()} d="M9.5 9.2 15 11.5 9.5 14V9.2Z" />
          <path {...strokeProps()} d="M9 21h6M12 18v3" />
        </>
      )}
      {name === 'thumb_up' && filled && (
        <path
          fill="currentColor"
          d="M3 10.5h4v10H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Zm6 10V10.2l3.4-6.4c.5-1 2-.6 2 .5v4.2h4.9a2.6 2.6 0 0 1 2.5 3.2l-1.4 5.6a4.2 4.2 0 0 1-4.1 3.2H9Z"
        />
      )}
      {name === 'thumb_up' && !filled && (
        <>
          <rect {...strokeProps()} x="2" y="10.5" width="5" height="10" rx="1" />
          <path {...strokeProps()} d="M9 20.5V10.2l3.4-6.4c.5-1 2-.6 2 .5v4.2h4.9a2.6 2.6 0 0 1 2.5 3.2l-1.4 5.6a4.2 4.2 0 0 1-4.1 3.2H9Z" />
        </>
      )}
      {name === 'favorite' && filled && (
        <path
          fill="currentColor"
          d="M12 21s-7.5-4.7-9.6-9.1C.7 8.3 2.7 4.5 6.5 4.5A5 5 0 0 1 12 7.7a5 5 0 0 1 5.5-3.2c3.8 0 5.8 3.8 4.1 7.4C19.5 16.3 12 21 12 21Z"
        />
      )}
      {name === 'favorite' && !filled && (
        <path {...strokeProps()} d="M12 20.5s-7.4-4.6-9.4-8.8C1 8.3 2.8 5 6.3 5A5 5 0 0 1 12 8.2 5 5 0 0 1 17.7 5c3.5 0 5.3 3.3 3.7 6.7-2 4.2-9.4 8.8-9.4 8.8Z" />
      )}
      {name === 'view_carousel' && (
        <>
          <rect {...strokeProps()} x="6" y="5" width="12" height="14" rx="2" />
          <path {...strokeProps()} d="M3 8v8m18-8v8" />
        </>
      )}
      {name === 'account_tree' && (
        <>
          <rect {...strokeProps()} x="3" y="4" width="6" height="5" rx="1.5" />
          <rect {...strokeProps()} x="15" y="4" width="6" height="5" rx="1.5" />
          <rect {...strokeProps()} x="9" y="15" width="6" height="5" rx="1.5" />
          <path {...strokeProps()} d="M6 9v2.5h12V9M12 11.5V15" />
        </>
      )}
      {name === 'visibility_off' && (
        <>
          <path {...strokeProps()} d="M3 3l18 18M10.6 10.6A2 2 0 0 0 13.4 13.4M9.2 5.4A10.3 10.3 0 0 1 12 5c5 0 8.5 4.2 10 7a16 16 0 0 1-3.2 4.1M6.2 6.8A16.4 16.4 0 0 0 2 12c1.5 2.8 5 7 10 7 1.3 0 2.5-.3 3.6-.8" />
        </>
      )}
      {name === 'compare' && (
        <>
          <rect {...strokeProps()} x="3" y="5" width="18" height="14" rx="2" />
          <path {...strokeProps()} d="M12 5v14" />
        </>
      )}
      {name === 'content_copy' && (
        <>
          <rect {...strokeProps()} x="8" y="8" width="11" height="12" rx="2" />
          <path {...strokeProps()} d="M5 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      )}
      {name === 'auto_awesome' && (
        <>
          <path fill="currentColor" d="m12 2 1.5 4.5L18 8l-4.5 1.5L12 14 10.5 9.5 6 8l4.5-1.5L12 2Z" />
          <path fill="currentColor" d="m19 13 .9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 13ZM5 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
        </>
      )}
    </svg>
  )
}
