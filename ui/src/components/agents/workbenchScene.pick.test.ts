import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three'
import { expect, it, vi } from 'vitest'

import { nearestShownHit } from './workbenchScene'

// A ray from the camera's side straight down -z, through boxes set along it.
const ray = () => new Raycaster(new Vector3(0, 0, 10), new Vector3(0, 0, -1))
const box = (name: string, z: number) => {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial())
  mesh.name = name
  mesh.position.z = z
  mesh.updateMatrixWorld(true)
  return mesh
}

it('finds the nearest part that shows, past hidden ones in front of it', () => {
  const garment = box('wear_coat_pose_rest', 4)
  garment.visible = false
  const head = box('head_mesh', 2)
  const wall = box('pegboard', -3)
  expect(nearestShownHit(ray(), [wall, garment, head])?.object).toBe(head)
})

it('never tests what is hidden, by itself or by its group: the pointer moving over the figure costs only what shows', () => {
  const garment = box('wear_coat_pose_rest', 4)
  garment.visible = false
  // A head it doesn't wear: shown itself, in a hidden group.
  const unworn = new Group()
  unworn.visible = false
  const otherHead = box('head_other', 3)
  unworn.add(otherHead)
  unworn.updateMatrixWorld(true)
  const head = box('head_mesh', 2)
  const tested = [vi.spyOn(garment, 'raycast'), vi.spyOn(otherHead, 'raycast')]
  const seen = vi.spyOn(head, 'raycast')

  expect(nearestShownHit(ray(), [garment, otherHead, head])?.object).toBe(head)
  for (const spy of tested) expect(spy).not.toHaveBeenCalled()
  expect(seen).toHaveBeenCalledTimes(1)
})

it('is null when nothing that shows is under the pointer', () => {
  const garment = box('wear_coat_pose_rest', 4)
  garment.visible = false
  const aside = box('lamp', 0)
  aside.position.x = 5
  aside.updateMatrixWorld(true)
  expect(nearestShownHit(ray(), [garment, aside])).toBeNull()
})
