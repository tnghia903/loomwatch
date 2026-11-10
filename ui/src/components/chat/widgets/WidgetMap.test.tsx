import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KeptWidget } from '../../../lib/widgets/types'
import { AnswerWidgets } from './AnswerWidgets'
import type { MapCanvasProps } from './WidgetMapCanvas'

// jsdom draws no WebGL: the map stands in as its pins, which say which one is in focus.
vi.mock('./WidgetMapCanvas', () => ({
  default: ({ places, picked, onPick }: MapCanvasProps) => (
    <div data-testid="map">
      {places.map((place, at) => (
        <button key={at} type="button" aria-pressed={at === picked} onClick={() => onPick(at)}>{`Pin ${place.name}`}</button>
      ))}
    </div>
  ),
}))

afterEach(cleanup)

const lunch: KeptWidget = {
  n: 1,
  spec: {
    kind: 'map',
    title: 'Lunch near Galaxis',
    from: { name: 'Galaxis', lat: 1.29947, lng: 103.78753 },
    places: [
      { name: 'Bread Yard', lat: 1.29875, lng: 103.78761, category: 'cafe', rating: 4.8, price: 2, note: 'A bakery-café that started at SUTD.', link: 'https://breadyard.sg/' },
      { name: 'Wok Palace', lat: 1.30561, lng: 103.79213, category: 'food', address: '1 Fusionopolis Way' },
    ],
  },
}

const draw = (kept: KeptWidget = lunch) => render(<AnswerWidgets widgets={[kept]} onChange={vi.fn()} />)

describe('a map in an answer', () => {
  it('shows a card for each place, with what the agent found and how far it is', async () => {
    draw()
    expect(await screen.findByTestId('map')).toBeTruthy()
    const cards = within(screen.getByRole('list', { name: 'Places' })).getAllByRole('listitem')
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toBe('Bread Yard★ 4.8 · $$ · Café80 m from Galaxis')
    expect(within(cards[0]).getByLabelText('Rated 4.8 out of 5')).toBeTruthy()
    expect(cards[1].textContent).toBe('Wok PalaceRestaurant850 m from Galaxis')
  })

  it('brings a place into focus when its pin is tapped', async () => {
    draw()
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Wok Palace' }))
    expect(screen.getByRole('button', { name: 'Pin Wok Palace' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /^Wok Palace/ }).className).toContain('picked')
  })

  it('opens a card on the map across the window, with its website and directions', async () => {
    draw()
    fireEvent.click(screen.getByRole('button', { name: /^Bread Yard/ }))
    const view = await screen.findByRole('dialog', { name: 'Lunch near Galaxis' })
    const place = within(view).getByRole('complementary', { name: 'Bread Yard' })
    expect(within(place).getByRole('heading', { name: 'Bread Yard' })).toBeTruthy()
    expect(within(place).getByText('A bakery-café that started at SUTD.')).toBeTruthy()
    expect(within(place).getByText('80 m from Galaxis, as the crow flies')).toBeTruthy()
    const site = within(place).getByRole('link', { name: 'Website' })
    expect(site.getAttribute('href')).toBe('https://breadyard.sg/')
    expect(site.getAttribute('rel')).toBe('noopener noreferrer')
    expect(document.activeElement).toBe(within(view).getByRole('button', { name: 'Close the map' }))

    // Another place on the map takes the card's place.
    fireEvent.click(within(place).getByRole('button', { name: /Wok Palace/ }))
    const wok = within(view).getByRole('complementary', { name: 'Wok Palace' })
    expect(within(wok).queryByRole('link', { name: 'Website' })).toBeNull()
    expect(within(wok).getByText('1 Fusionopolis Way')).toBeTruthy()
  })

  it('asks which maps app to open for directions, and Escape closes one thing at a time', async () => {
    draw()
    fireEvent.click(screen.getByRole('button', { name: 'Show the map larger' }))
    const view = await screen.findByRole('dialog', { name: 'Lunch near Galaxis' })
    fireEvent.click(within(view).getByRole('button', { name: 'Directions' }))
    const ask = screen.getByRole('alertdialog', { name: 'Open in' })
    expect(within(ask).getByRole('link', { name: 'Apple Maps' }).getAttribute('href')).toBe('https://maps.apple.com/?daddr=1.29875%2C103.78761')
    expect(within(ask).getByRole('link', { name: 'Google Maps' }).getAttribute('href')).toBe('https://www.google.com/maps/dir/?api=1&destination=1.29875%2C103.78761')
    expect(document.activeElement).toBe(within(ask).getByRole('link', { name: 'Apple Maps' }))
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    fireEvent.click(within(view).getByRole('button', { name: 'Directions' }))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('draws a place the agent found only the name and position of', async () => {
    draw({ n: 2, spec: { kind: 'map', title: 'Where to meet', places: [{ name: 'The fountain', lat: 1.3, lng: 103.8 }] } })
    const card = within(await screen.findByRole('list', { name: 'Places' })).getByRole('listitem')
    expect(card.textContent).toBe('The fountain')
    fireEvent.click(within(card).getByRole('button'))
    const place = within(await screen.findByRole('dialog')).getByRole('complementary', { name: 'The fountain' })
    expect(within(place).getByRole('button', { name: 'Directions' }).className).toContain('primary')
    expect(within(place).queryByRole('navigation')).toBeNull()
  })
})
