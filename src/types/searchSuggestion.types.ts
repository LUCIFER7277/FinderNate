import { Document } from 'mongoose';

export interface ISearchSuggestion extends Document {
    keyword: string;
    searchCount: number;
    lastSearched: Date;
    createdAt: Date;
    updatedAt: Date;
}
