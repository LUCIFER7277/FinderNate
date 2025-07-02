import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

const app = express();

app.use(cors({
    origin: process.env.ORIGIN,
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({extended: true}));
app.use(cookieParser());

//import route
import userRouter from './routes/user.routes.js';

app.use("/api/v1/users", userRouter);

export { app };
