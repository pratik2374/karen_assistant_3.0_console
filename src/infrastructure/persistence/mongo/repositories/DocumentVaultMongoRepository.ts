import { Db, Collection } from 'mongodb';

export interface DocumentVaultEntry {
  docId: string;
  name: string;
  link: string;
  aliases: string[];
}

export class DocumentVaultMongoRepository {
  private collection: Collection<DocumentVaultEntry>;

  constructor(db: Db) {
    this.collection = db.collection<DocumentVaultEntry>('user_vault');
  }

  public async save(entry: DocumentVaultEntry): Promise<void> {
    await this.collection.updateOne(
      { docId: entry.docId },
      { $set: entry },
      { upsert: true }
    );
  }

  public async delete(docId: string): Promise<void> {
    await this.collection.deleteOne({ docId });
  }

  public async findById(docId: string): Promise<DocumentVaultEntry | null> {
    return this.collection.findOne({ docId });
  }

  public async findAll(): Promise<DocumentVaultEntry[]> {
    return this.collection.find({}).toArray();
  }

  public async findByAlias(query: string): Promise<DocumentVaultEntry[]> {
    // Fuzzy search: matches name or aliases case-insensitively using regex
    const regex = new RegExp(query, 'i');
    return this.collection.find({
      $or: [
        { name: { $regex: regex } },
        { aliases: { $in: [regex] } }
      ]
    }).toArray();
  }
}
