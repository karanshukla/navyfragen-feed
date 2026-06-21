import SqliteDb from 'better-sqlite3'
import { Kysely, Migrator, SqliteDialect } from 'kysely'
import { DatabaseSchema } from './schema'
import { migrationProvider } from './migrations'

export const createDb = (location: string): Database => {
  const db = new SqliteDb(location)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('mmap_size = 16777216') // 16MB — enough for a small feed
  db.pragma('cache_size = -1000') // 1MB page cache
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: db,
    }),
  })
}

export const migrateToLatest = async (db: Database) => {
  const migrator = new Migrator({ db, provider: migrationProvider })
  const { error } = await migrator.migrateToLatest()
  if (error) throw error
}

export type Database = Kysely<DatabaseSchema>
