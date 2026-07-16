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
