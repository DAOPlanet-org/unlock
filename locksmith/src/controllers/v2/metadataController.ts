import type { Web3Service } from '@unlock-protocol/unlock-js'
import { Response, Request } from 'express'
import * as z from 'zod'
import { Op } from 'sequelize'
import Normalizer from '../../utils/normalizer'
import * as metadataOperations from '../../operations/metadataOperations'
import logger from '../../logger'
import { KeyMetadata } from '../../models/keyMetadata'
import { LockMetadata } from '../../models/lockMetadata'
import { UserTokenMetadata } from '../../models'
import * as lockOperations from '../../operations/lockOperations'
import { isEmpty } from 'lodash'
import { getDefaultLockData } from '../../utils/metadata'

const UserMetadata = z
  .object({
    public: z.record(z.string(), z.any()).optional(),
    protected: z.record(z.string(), z.any()).optional(),
  })
  .strict()
  .partial()

const UserMetadataBody = z.object({
  lockAddress: z.string().transform((item) => Normalizer.ethereumAddress(item)),
  userAddress: z.string().transform((item) => Normalizer.ethereumAddress(item)),
  metadata: UserMetadata,
})

const BulkUserMetadataBody = z.object({
  users: z.array(UserMetadataBody),
})

function isMetadataEmpty(data: Record<string, any>) {
  const publicData = isEmpty(data?.public)
  const protectedData = isEmpty(data?.protected)
  return publicData && protectedData
}

export class MetadataController {
  public web3Service: Web3Service

  constructor({ web3Service }: { web3Service: Web3Service }) {
    this.web3Service = web3Service
  }

  async getLockMetadata(request: Request, response: Response) {
    try {
      const network = Number(request.params.network)
      const lockAddress = Normalizer.ethereumAddress(request.params.lockAddress)

      const lockData = await LockMetadata.findOne({
        where: {
          chain: network,
          address: lockAddress,
        },
      })

      if (!lockData) {
        const defaultLockData = await getDefaultLockData({
          lockAddress,
          network,
        })
        return response.status(200).send(defaultLockData)
      }
      return response.status(200).send(lockData.data)
    } catch (error) {
      logger.error(error.message)
      return response.status(500).send({
        message: 'There were some problems in getting the lock data.',
      })
    }
  }

  /**
   * Yields the metadata associated with a key and includes protected
   * fields if the request is performed by key owner or verifier
   * @param request
   * @param response
   * @returns
   */
  async getKeyMetadata(request: Request, response: Response) {
    try {
      const keyId = request.params.keyId.toLowerCase()
      const lockAddress = Normalizer.ethereumAddress(request.params.lockAddress)
      const network = Number(request.params.network)
      const host = `${request.protocol}://${request.headers.host}`

      const includeProtected =
        await metadataOperations.isKeyOwnerOrLockVerifier({
          keyId,
          network,
          lockAddress,
          userAddress: request.user?.walletAddress,
        })

      const keyData = await metadataOperations.generateKeyMetadata(
        lockAddress,
        keyId,
        includeProtected,
        host,
        network
      )

      return response.status(200).send(keyData)
    } catch (error) {
      logger.error(error.message)
      return response.status(500).send({
        message: 'There were some problems in getting the key metadata.',
      })
    }
  }

  async updateLockMetadata(request: Request, response: Response) {
    try {
      const lockAddress = Normalizer.ethereumAddress(request.params.lockAddress)
      const network = Number(request.params.network)
      const { metadata } = request.body
      const [updatedLockMetadata] = await LockMetadata.upsert(
        {
          address: lockAddress,
          chain: network,
          data: {
            ...metadata,
          },
        },
        {
          returning: true,
        }
      )
      return response.status(200).send(updatedLockMetadata.data)
    } catch (error) {
      logger.error(error.message)
      return response.status(500).send({
        message: 'There were some problems in updating the lock metadata.',
      })
    }
  }

  async updateKeyMetadata(request: Request, response: Response) {
    try {
      const keyId = request.params.keyId.toLowerCase()
      const { metadata } = request.body
      const lockAddress = Normalizer.ethereumAddress(request.params.lockAddress)
      const network = Number(request.params.network)
      const host = `${request.protocol}://${request.headers.host}`

      await KeyMetadata.upsert(
        {
          chain: network,
          address: lockAddress,
          id: keyId,
          data: {
            ...metadata,
          },
        },
        {
          conflictFields: ['address', 'id'],
        }
      )

      const keyData = await metadataOperations.generateKeyMetadata(
        lockAddress,
        keyId,
        true /* isLockManager */,
        host,
        network
      )

      return response.status(200).send(keyData)
    } catch (error) {
      logger.error(error.message)
      return response.status(500).send({
        message: 'There were some problems in updating the key metadata.',
      })
    }
  }

  async createUserMetadata(request: Request, response: Response) {
    try {
      const tokenAddress = Normalizer.ethereumAddress(
        request.params.lockAddress
      )
      const userAddress = Normalizer.ethereumAddress(request.params.userAddress)
      const network = Number(request.params.network)
      const metadata = await UserMetadata.parseAsync(request.body.metadata)
      const userData = await UserTokenMetadata.findOne({
        where: {
          userAddress,
          tokenAddress,
          chain: network,
        },
      })

      // If no metadata was set previously, we let anyone set it.
      if (isMetadataEmpty(userData?.data?.userMetadata)) {
        const [createdUser] = await UserTokenMetadata.upsert(
          {
            tokenAddress,
            chain: network,
            userAddress: userAddress,
            data: {
              userMetadata: {
                ...metadata,
              },
            },
          },
          {
            returning: true,
            conflictFields: ['userAddress', 'tokenAddress'],
          }
        )
        return response.status(201).send(createdUser.data)
      }

      return response.status(409).send({
        message: 'User metadata already exists.',
      })
    } catch (error) {
      logger.error(error.message)

      if (error instanceof z.ZodError) {
        return response.status(400).send({
          message: 'User metadata is not in the correct form.',
          error: error.format(),
        })
      }

      return response.status(500).send({
        message: 'User metadata could not be added.',
      })
    }
  }

  async updateUserMetadata(request: Request, response: Response) {
    try {
      const tokenAddress = Normalizer.ethereumAddress(
        request.params.lockAddress
      )
      const userAddress = Normalizer.ethereumAddress(request.params.userAddress)
      const loggedUserAddress = Normalizer.ethereumAddress(
        request.user!.walletAddress
      )
      const network = Number(request.params.network)
      const metadata = await UserMetadata.parseAsync(request.body.metadata)

      const isUserMetadataOwner = userAddress === loggedUserAddress

      const isLockOwner = this.web3Service.isLockManager(
        tokenAddress,
        loggedUserAddress,
        network
      )

      const userData = await UserTokenMetadata.findOne({
        where: {
          userAddress,
          tokenAddress,
        },
      })

      if (!userData) {
        return response.status(404).send({
          message: "User metadata doesn't exist.",
        })
      }

      if (!(isLockOwner || isUserMetadataOwner)) {
        return response.status(403).send({
          message:
            'You are not authorized to update user metadata for this key.',
        })
      }

      const [rows, updatedUserMetadata] = await UserTokenMetadata.update(
        {
          data: {
            userMetadata: {
              ...metadata,
            },
          },
        },
        {
          where: {
            tokenAddress,
            userAddress,
            chain: network,
          },
          returning: true,
        }
      )

      if (!rows) {
        return response.status(500).send({
          message: 'Failed to update the user metadata.',
        })
      }
      return response.status(204).send(updatedUserMetadata[0].data)
    } catch (error) {
      logger.error(error.message)

      if (error instanceof z.ZodError) {
        return response.status(400).send({
          message: 'User metadata is not in the correct form.',
          error: error.format(),
        })
      }

      return response.status(500).send({
        message: 'There were some problems in updating user metadata.',
      })
    }
  }

  async createBulkUserMetadata(request: Request, response: Response) {
    try {
      const network = Number(request.params.network)
      const { users } = await BulkUserMetadataBody.parseAsync(request.body)
      const query = users.map((user) => {
        const tokenAddress = Normalizer.ethereumAddress(user.lockAddress)
        const userAddress = Normalizer.ethereumAddress(user.userAddress)
        return {
          [Op.and]: [
            {
              tokenAddress,
            },
            {
              userAddress,
            },
          ],
        }
      })

      const userMetadataResults = await UserTokenMetadata.findAll({
        where: {
          [Op.or]: query,
        },
      })

      const filteredUsers = users.filter(
        (user) =>
          !userMetadataResults.some(
            ({ tokenAddress, userAddress, data }) =>
              user.lockAddress === tokenAddress &&
              user.userAddress === userAddress &&
              !isMetadataEmpty(data?.userMetadata)
          )
      )

      const newUsersData = filteredUsers.map(
        ({ userAddress, lockAddress, metadata }) => {
          const data = UserMetadata.parse(metadata)
          const newUserData = {
            userAddress,
            tokenAddress: lockAddress,
            chain: network,
            data: {
              userMetadata: {
                ...data,
              },
            },
          }
          return newUserData
        }
      )

      // Sequelize v6.x support bulk upsert in the bulkCreate so replace
      const result = await Promise.all(
        newUsersData.map(async (item) => {
          const [createdUser] = await UserTokenMetadata.upsert(item, {
            returning: true,
            conflictFields: ['tokenAddress', 'userAddress'],
          })
          return createdUser.toJSON()
        })
      )

      return response.status(201).send({
        result,
      })
    } catch (error) {
      logger.error(error)
      if (error instanceof z.ZodError) {
        return response.status(400).send({
          message: 'User metadata is not in the correct form.',
          error: error.format(),
        })
      }
      return response.status(500).send({
        message: 'Bulk user metadata could not be added.',
      })
    }
  }

  async getBulkKeysMetadata(request: Request, response: Response) {
    try {
      const lockAddress = Normalizer.ethereumAddress(request.params.lockAddress)
      const network = Number(request.params.network)
      const { keys }: any = request.body

      if (!keys) {
        return response
          .send({
            message: 'Parameter `keys` is not present',
          })
          .status(500)
      }

      const owners: { owner: string; keyId: string }[] = keys?.map(
        ({ owner, keyId }: any) => {
          return {
            owner: owner?.address,
            keyId,
          }
        }
      )

      const mergedDataList = owners.map(async ({ owner, keyId }) => {
        let metadata: any = undefined
        const keyData = await metadataOperations.getKeyCentricData(
          lockAddress,
          keyId
        )
        const [keyMetadata] = await lockOperations.getKeyHolderMetadata(
          lockAddress,
          [owner],
          network
        )

        const keyMetadataData = keyMetadata?.data || undefined

        const hasMetadata =
          [...Object.keys(keyData ?? {}), ...Object.keys(keyMetadataData ?? {})]
            .length > 0

        // build metadata object only if metadata or extraMetadata are present
        if (hasMetadata) {
          metadata = {
            userAddress: owner,
            data: {
              ...keyMetadataData,
              extraMetadata: {
                ...keyData?.metadata,
              },
            },
          }
        }
        return metadata
      })

      const mergedData = await Promise.all(mergedDataList)
      const filtredMergedData = mergedData.filter(Boolean)

      return response.send(filtredMergedData).status(200)
    } catch (err) {
      logger.error(err.message)
      return response.status(400).send({
        message: 'There were some problems from getting keys metadata.',
      })
    }
  }
}
