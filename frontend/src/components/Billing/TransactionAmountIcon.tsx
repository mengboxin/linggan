import { CircleMinus, CirclePlus } from 'lucide-react'

interface TransactionAmountIconProps {
  amount: number
  className?: string
}

export function TransactionAmountIcon({ amount, className = '' }: TransactionAmountIconProps) {
  const debit = Number(amount || 0) < 0
  const Icon = debit ? CircleMinus : CirclePlus
  return (
    <span
      className={`transaction-amount-icon ${className}`}
      aria-label={debit ? '扣除积分' : '增加积分'}
      data-testid={debit ? 'transaction-minus-icon' : 'transaction-plus-icon'}
    >
      <Icon size={18} strokeWidth={2.2} aria-hidden="true" />
    </span>
  )
}

export default TransactionAmountIcon
