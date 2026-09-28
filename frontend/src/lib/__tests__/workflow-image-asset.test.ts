import { describe, expect, it } from 'vitest'
import {
  canonicalWorkflowImage,
  legacyWorkflowNodeImportSource,
  workflowAssetIdFromUrl,
  workflowNodeAssetUrl,
} from '../workflow-image-asset'

describe('workflow image assets', () => {
  it('derives all three variants from one immutable asset id', () => {
    expect(canonicalWorkflowImage('asset-123')).toEqual({
      assetId: 'asset-123',
      imageBase64: '/api/assets/asset-123/original',
      imageUrl: '/api/assets/asset-123/original',
      previewUrl: '/api/assets/asset-123/preview',
      thumbnailUrl: '/api/assets/asset-123/thumb',
      thumbnailBase64: '/api/assets/asset-123/thumb',
    })
  })

  it('always uses the original variant for workflow model input', () => {
    expect(workflowNodeAssetUrl({ assetId: 'source-asset' }, 'original')).toBe('/api/assets/source-asset/original')
  })

  it('restores an asset id from a legacy canonical URL without copying the image again', () => {
    expect(workflowAssetIdFromUrl('/api/assets/source-asset/thumb?token=old')).toBe('source-asset')
  })

  it('uses one legacy source only while a historical node is migrated', () => {
    expect(legacyWorkflowNodeImportSource({
      imageBase64: 'data:image/png;base64,source',
      imageUrl: 'https://old.example/image.png',
    })).toBe('data:image/png;base64,source')
  })
})
