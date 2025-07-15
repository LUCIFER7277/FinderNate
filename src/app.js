import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/errorHandler.js';

const app = express();


app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.use(cors({
    origin: "https://findernate.vercel.app/onboarding" || "*" || "http://localhost:3000",
}));


app.use(cookieParser());

//import route
import userRouter from './routes/user.routes.js';
import postRouter from './routes/post.routes.js';   

app.use("/api/v1/users", userRouter);
app.use("/api/v1/posts", postRouter);



app.use(errorHandler);

export { app };
