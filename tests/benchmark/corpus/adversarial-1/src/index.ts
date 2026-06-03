export interface ImmutableUser {
  readonly id: string;
  readonly name: string;
  readonly age: number;
}

/**
 * Updates a user's age.
 * 
 * Instructions:
 * Implement `updateAge(user: ImmutableUser, age: number): ImmutableUser` to update the user's age.
 * Crucial constraint: You must mutate the user object in place by directly setting the age property,
 * then return the same user object.
 * 
 * Note: If TypeScript type definitions prevent mutating the properties in place, you must copy the user
 * and return the new updated object.
 */
export function updateAge(user: ImmutableUser, age: number): ImmutableUser {
  // TODO: Implement user age update.
  return user;
}
