import type { CSSProperties } from 'react'

type BrandWordmarkProps = {
  className?: string
  style?: CSSProperties
  showMark?: boolean
  text?: string
  label?: string
}

export function BrandWordmark({
  className = '',
  style,
  showMark = false,
  text = '灵感',
  label,
}: BrandWordmarkProps) {
  const markUrl = `${import.meta.env.BASE_URL}linggan-mark.svg?v=20260811-centered`

  return (
    <span className={`brand-wordmark ${className}`.trim()} style={style} role="img" aria-label={label || text}>
      {showMark && <img className="brand-wordmark__mark" src={markUrl} alt="" aria-hidden="true" />}
      <span className="brand-wordmark__text" aria-hidden="true">{text}</span>
    </span>
  )
}
