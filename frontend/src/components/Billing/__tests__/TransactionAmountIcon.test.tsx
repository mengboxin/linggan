import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TransactionAmountIcon } from '../TransactionAmountIcon'

describe('TransactionAmountIcon', () => {
  it('renders a visible minus icon for debit records', () => {
    render(<TransactionAmountIcon amount={-2} />)
    expect(screen.getByLabelText('扣除积分')).toBeInTheDocument()
    expect(screen.getByTestId('transaction-minus-icon')).toBeInTheDocument()
  })
})
