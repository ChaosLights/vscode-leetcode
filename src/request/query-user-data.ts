import { UserDataType } from "../globalState";
import { getUrl } from "../shared";
import { LcAxios } from "../utils/httpUtils";

const graphqlStr = `
    query globalData {
        userStatus {
            isPremium
            isVerified
            username
            avatar
            isSignedIn
        }
    }
`;

export const queryUserData = async (cookie?: string): Promise<UserDataType> => {
    return LcAxios(getUrl("userGraphql"), {
        method: "POST",
        data: {
            query: graphqlStr,
            variables: {},
        },
    }, cookie).then((res) => res.data.data.userStatus);
};

export const queryFavoriteHash = async (cookie: string): Promise<string | undefined> => {
    return LcAxios(getUrl("favorites"), { method: "GET" }, cookie).then((res) => {
        const favorites: any[] = res.data?.favorites?.private_favorites || [];
        const favorite: any | undefined = favorites.find((item: any) => item.name === "Favorite");
        return favorite && typeof favorite.id_hash === "string" ? favorite.id_hash : undefined;
    });
};
