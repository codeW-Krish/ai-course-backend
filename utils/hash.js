import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

export const hashPassword = (plainPassword) => {
    return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

export const verifyPassword = (plainPass, hashedPass) => {
    return bcrypt.compare(plainPass, hashedPass)
}