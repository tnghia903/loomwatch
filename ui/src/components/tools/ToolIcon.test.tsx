import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ToolIcon } from './ToolIcon'

afterEach(cleanup)

describe('a tool’s icon', () => {
  it('shows the icon LoomWatch keeps, and the first letter when there is none or it fails', () => {
    const { container, rerender } = render(<ToolIcon name="Kiwi.com" icon="/api/tools/icon/www.kiwi.com" />)
    const img = container.querySelector('img')!
    expect(img).toHaveAttribute('src', '/api/tools/icon/www.kiwi.com')
    expect(img).toHaveAttribute('alt', '')
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('K')
    // A new address tries again.
    rerender(<ToolIcon name="Kiwi.com" icon="/api/tools/icon/kiwi.com" />)
    expect(container.querySelector('img')).toHaveAttribute('src', '/api/tools/icon/kiwi.com')
    rerender(<ToolIcon name="peek" icon={null} />)
    expect(container).toHaveTextContent('P')
  })
})
