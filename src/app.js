import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/errorHandler.js';

const app = express();


app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.use(cors({
    origin: ["http://localhost:3000", "https://findernate.vercel.app", "*"],
    credentials: true
}));


app.use(cookieParser());

//import route
import userRouter from './routes/user.routes.js';
import postRouter from './routes/post.routes.js';   
import storyRouter from './routes/story.routes.js';
import reelRouter from "./routes/reel.routes.js";
import exploreRouter from "./routes/explore.routes.js";

app.use("/api/v1/users", userRouter);
app.use("/api/v1/posts", postRouter);
app.use("/api/v1/stories", storyRouter);
app.use("/api/v1/reels", reelRouter);
app.use("/api/v1/explore", exploreRouter);

app.use(errorHandler);

export { app };
