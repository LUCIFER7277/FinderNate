import { Document, Types } from 'mongoose';

export interface ISearchHistory extends Document {
    userId: Types.ObjectId;
    keyword: string;
    searchedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}
