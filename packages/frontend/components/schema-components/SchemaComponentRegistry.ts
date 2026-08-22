import type { SchemaComponent } from './types'

/**
 * Registry for managing custom schema components.
 * Allows mapping specific schema UIDs to custom React components
 * while providing fallback to generic components for unmapped schemas.
 */
export class SchemaComponentRegistry {
  private components = new Map<string, SchemaComponent>()

  /**
   * Schema UIDs are keyed case-insensitively: the same schema arrives checksummed from the config
   * file and lowercased from the indexer's `/instances` route, and a case mismatch would silently
   * fall back to the generic form.
   */
  private key = (schemaUid: string) => schemaUid.toLowerCase()

  /**
   * Register a custom component for a specific schema UID
   */
  register(schemaUid: string, component: SchemaComponent): void {
    this.components.set(this.key(schemaUid), component)
  }

  /**
   * Get the custom component for a schema UID, or null if none registered
   */
  getComponent(schemaUid: string): SchemaComponent | null {
    return this.components.get(this.key(schemaUid)) || null
  }

  /**
   * Check if a custom component is registered for this schema UID
   */
  hasCustomComponent(schemaUid: string): boolean {
    return this.components.has(this.key(schemaUid))
  }

  /**
   * Unregister a custom component for a schema UID
   */
  unregister(schemaUid: string): boolean {
    return this.components.delete(this.key(schemaUid))
  }

  /**
   * Get all registered schema UIDs
   */
  getRegisteredSchemas(): string[] {
    return Array.from(this.components.keys())
  }

  /**
   * Clear all registered components
   */
  clear(): void {
    this.components.clear()
  }
}

// Export singleton registry instance
export const schemaComponentRegistry = new SchemaComponentRegistry()
